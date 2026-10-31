/**
 * Several API addresses, primary first: the eventKit API on its own server and
 * the same API on Vercel share one database, so either can answer any request.
 * Requests go to the first address that isn't marked down; when it can't be
 * reached they move to the next one and stay there for a minute, then try the
 * primary again.
 *
 * The eventkit-console keeps a copy of this file (src/api/failover.ts): change both.
 */

export interface FailoverOptions {
  /** Default: the global fetch, resolved per request. */
  fetch?: (request: Request) => Promise<Response>;
  /** How long an address that failed is skipped. Default 60 s. */
  downMs?: number;
  /** GET and HEAD give up on an address after this long. Default 10 s. */
  timeoutMs?: number;
  /** Before resending a POST, PATCH, PUT or DELETE, the failed address's /health gets this long. Default 3 s. */
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
  const timeoutMs = options.timeoutMs ?? 10_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 3_000;
  const now = options.now ?? Date.now;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const send = options.fetch ?? ((r: Request) => globalThis.fetch(r));
  const downUntil = new Map<string, number>();

  function stored(): Record<string, number> {
    try {
      const v: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
      return v && typeof v === 'object' ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  function isDown(url: string): boolean {
    return Math.max(downUntil.get(url) ?? 0, stored()[url] ?? 0) > now();
  }

  function markDown(url: string) {
    const until = now() + downMs;
    downUntil.set(url, until);
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ ...stored(), [url]: until }));
    } catch {
      // Storage full or blocked: this tab still remembers.
    }
  }

  /** The address requests go to now. With every one marked down, the primary. */
  function activeUrl(): string {
    return urls.find((u) => !isDown(u)) ?? urls[0]!;
  }

  async function reachable(url: string): Promise<boolean> {
    try {
      const res = await send(
        new Request(`${url}/health`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(healthTimeoutMs),
        }),
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async function failoverFetch(request: Request): Promise<Response> {
    const base = urls.find((u) => request.url.startsWith(u));
    if (!base) return send(request);
    const path = request.url.slice(base.length);
    const safe = SAFE.has(request.method);
    const body = safe ? undefined : await request.clone().arrayBuffer();
    const candidates = urls.filter((u) => !isDown(u));
    const order = candidates.length > 0 ? candidates : urls;

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
      if (!safe && (await reachable(url))) {
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
