/**
 * Several API addresses, primary first: the eventKit API on its own server and
 * the same API on Vercel share one database, so either can answer any request.
 * Requests go to the first address that works. When one can't be reached it is
 * marked down and requests move to the next; while it is marked down, every
 * request first checks its /health (uncached, one check shared for a few
 * seconds) and goes back to it as soon as it answers.
 *
 * The eventkit-console keeps a copy of this file (src/api/failover.ts): change both.
 */

export interface FailoverOptions {
  /** Default: the global fetch, resolved per request. */
  fetch?: (request: Request) => Promise<Response>;
  /** A down mark's longest life; after it, the address is used again without a check. Default 60 s. */
  downMs?: number;
  /** How long one /health check of a down address is reused. Default 5 s. */
  recheckMs?: number;
  /** GET and HEAD give up on an address after this long. Default 10 s. */
  timeoutMs?: number;
  /** A /health check gets this long. Default 3 s. */
  healthTimeoutMs?: number;
  /** Where down marks are shared across reloads and tabs. Default: localStorage when there is one. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
}

const STORAGE_KEY = 'eventkit:api-down';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** "a, b/" → ["a", "b"]: a comma-separated list of API addresses. */
export function splitApiUrls(apiUrl: string): string[] {
  return apiUrl
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * An error page from a proxy in front of the API (Cloudflare's 530 when the
 * tunnel is down, a 502 from Caddy), not an answer from the API: the API
 * always answers in JSON, including its own 503 DATABASE_BUSY.
 */
export function isProxyFailure(res: Response): boolean {
  const gateway = [502, 503, 504].includes(res.status) || (res.status >= 520 && res.status <= 530);
  return gateway && !(res.headers.get('content-type') ?? '').includes('application/json');
}

function defaultStorage(): FailoverOptions['storage'] {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createFailoverFetch(urls: string[], options: FailoverOptions = {}) {
  const downMs = options.downMs ?? 60_000;
  const recheckMs = options.recheckMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 3_000;
  const now = options.now ?? Date.now;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const send = options.fetch ?? ((r: Request) => globalThis.fetch(r));
  const downUntil = new Map<string, number>();
  const checked = new Map<string, { at: number; ok: boolean }>();
  const checking = new Map<string, Promise<boolean>>();

  function stored(): Record<string, number> {
    try {
      const v: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
      return v && typeof v === 'object' ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  function save(marks: Record<string, number>) {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(marks));
    } catch {
      // Storage full or blocked: this tab still remembers.
    }
  }

  function isDown(url: string): boolean {
    return Math.max(downUntil.get(url) ?? 0, stored()[url] ?? 0) > now();
  }

  function markDown(url: string) {
    const until = now() + downMs;
    downUntil.set(url, until);
    checked.set(url, { at: now(), ok: false });
    save({ ...stored(), [url]: until });
  }

  function markUp(url: string) {
    downUntil.delete(url);
    const marks = stored();
    delete marks[url];
    save(marks);
  }

  /** GET <url>/health, never from a cache. Records the answer. */
  async function probe(url: string): Promise<boolean> {
    let ok: boolean;
    try {
      const res = await send(
        new Request(`${url}/health`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(healthTimeoutMs),
        }),
      );
      ok = res.ok;
    } catch {
      ok = false;
    }
    checked.set(url, { at: now(), ok });
    if (ok) markUp(url);
    return ok;
  }

  /** Whether a down address is back: a recent check's answer, or a new check (one at a time). */
  function isBack(url: string): Promise<boolean> {
    const last = checked.get(url);
    if (last && now() - last.at < recheckMs) return Promise.resolve(last.ok);
    let pending = checking.get(url);
    if (!pending) {
      pending = probe(url).finally(() => checking.delete(url));
      checking.set(url, pending);
    }
    return pending;
  }

  /**
   * The addresses to try, in order: every one that isn't marked down, and a
   * down one that answers its check. A down address is only checked while
   * nothing before it works, so the primary is checked and later ones aren't.
   */
  async function usable(): Promise<string[]> {
    const order: string[] = [];
    for (const url of urls) {
      if (!isDown(url) || (order.length === 0 && (await isBack(url)))) order.push(url);
    }
    return order.length > 0 ? order : urls;
  }

  /** The address requests go to now, as far as is known without a check. */
  function activeUrl(): string {
    return urls.find((u) => !isDown(u)) ?? urls[0]!;
  }

  async function failoverFetch(request: Request): Promise<Response> {
    const base = urls.find((u) => request.url.startsWith(u));
    if (!base) return send(request);
    const path = request.url.slice(base.length);
    const safe = SAFE.has(request.method);
    const body = safe ? undefined : await request.clone().arrayBuffer();
    const order = await usable();

    for (let i = 0; i < order.length; i++) {
      const url = order[i]!;
      const last = i === order.length - 1;
      const signal = safe
        ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
        : request.signal;
      const attempt = new Request(`${url}${path}`, {
        method: request.method,
        headers: request.headers,
        body: body && body.byteLength > 0 ? body : undefined,
        signal,
      });
      let failure: unknown;
      try {
        const res = await send(attempt);
        if (!isProxyFailure(res) || last) return res;
        failure = res;
      } catch (err) {
        // The caller cancelled: not the address's fault.
        if (request.signal.aborted || last) throw err;
        failure = err;
      }
      // A write may already have been handled: resend it only if the address is really down.
      if (!safe && (await probe(url))) {
        if (failure instanceof Response) return failure;
        throw failure;
      }
      markDown(url);
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  }

  return { fetch: failoverFetch, activeUrl, urls };
}
