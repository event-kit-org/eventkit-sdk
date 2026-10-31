import { describe, expect, it, vi } from 'vitest';
import {
  createEventKit,
  createFailoverFetch,
  isProxyFailure,
  memorySession,
  Session,
  splitApiUrls,
} from '../src';
import { createTransport } from '../src/http';

const SERVER = 'https://api.server.test';
const VERCEL = 'https://api.vercel.test';

type Handler = (req: Request) => Response | Promise<Response>;

/** A fake network: per-host handlers, every request recorded. */
function network(hosts: Record<string, Handler>) {
  const seen: Request[] = [];
  const fetch = vi.fn(async (req: Request) => {
    seen.push(req);
    const handler = hosts[new URL(req.url).origin];
    if (!handler) throw new TypeError('Failed to fetch');
    return handler(req);
  });
  return { fetch, seen, hosts: () => seen.map((r) => new URL(r.url).origin) };
}

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const down: Handler = () => {
  throw new TypeError('Failed to fetch');
};
const tunnelDown: Handler = () =>
  new Response('<html>Cloudflare Tunnel error</html>', {
    status: 530,
    headers: { 'content-type': 'text/html' },
  });

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function setup(hosts: Record<string, Handler>, extra: { now?: () => number } = {}) {
  const net = network(hosts);
  const storage = memoryStorage();
  const f = createFailoverFetch([SERVER, VERCEL], { fetch: net.fetch, storage, ...extra });
  return { ...net, storage, f };
}

describe('splitApiUrls and isProxyFailure', () => {
  it('splits a comma-separated list and trims slashes and spaces', () => {
    expect(splitApiUrls(`${SERVER}/, ${VERCEL} ,`)).toEqual([SERVER, VERCEL]);
    expect(splitApiUrls('/api')).toEqual(['/api']);
  });

  it("tells a proxy's error page from the API's own errors", () => {
    expect(isProxyFailure(tunnelDown(new Request(SERVER)) as Response)).toBe(true);
    expect(isProxyFailure(new Response('', { status: 502 }))).toBe(true);
    const busy = new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    expect(isProxyFailure(busy)).toBe(false);
    expect(isProxyFailure(new Response('', { status: 500 }))).toBe(false);
  });
});

describe('createFailoverFetch', () => {
  it('uses the primary while it answers', async () => {
    const { f, hosts } = setup({ [SERVER]: () => ok(), [VERCEL]: () => ok() });
    const res = await f.fetch(new Request(`${SERVER}/v1/auth/me?x=1`));
    expect(res.ok).toBe(true);
    expect(hosts()).toEqual([SERVER]);
    expect(f.activeUrl()).toBe(SERVER);
  });

  it('moves a GET to the next address when the primary is unreachable, and stays there', async () => {
    const { f, seen, hosts } = setup({ [SERVER]: down, [VERCEL]: () => ok() });
    const req = new Request(`${SERVER}/v1/events?x=1`, { headers: { 'x-api-key': 'k' } });
    expect((await f.fetch(req)).ok).toBe(true);
    expect(seen[1]!.url).toBe(`${VERCEL}/v1/events?x=1`);
    expect(seen[1]!.headers.get('x-api-key')).toBe('k');
    expect(f.activeUrl()).toBe(VERCEL);

    await f.fetch(new Request(`${SERVER}/v1/events`));
    expect(hosts()).toEqual([SERVER, VERCEL, VERCEL]);
  });

  it("moves on Cloudflare's tunnel error page, but not on the API's own JSON 503", async () => {
    const t = setup({ [SERVER]: tunnelDown, [VERCEL]: () => ok() });
    expect((await t.f.fetch(new Request(`${SERVER}/x`))).ok).toBe(true);
    expect(t.hosts()).toEqual([SERVER, VERCEL]);

    const busy = () =>
      new Response('{"error":{}}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    const b = setup({ [SERVER]: busy, [VERCEL]: () => ok() });
    expect((await b.f.fetch(new Request(`${SERVER}/x`))).status).toBe(503);
    expect(b.hosts()).toEqual([SERVER]);
  });

  it('gives up on a hung primary after the timeout', async () => {
    const hang: Handler = (req) =>
      new Promise((_, reject) =>
        req.signal.addEventListener('abort', () => reject(req.signal.reason)),
      );
    const net = network({ [SERVER]: hang, [VERCEL]: () => ok() });
    const f = createFailoverFetch([SERVER, VERCEL], {
      fetch: net.fetch,
      storage: null,
      timeoutMs: 20,
    });
    expect((await f.fetch(new Request(`${SERVER}/x`))).ok).toBe(true);
    expect(net.hosts()).toEqual([SERVER, VERCEL]);
  });

  it('resends a write, body and all, only once the primary is confirmed down', async () => {
    const { f, seen, hosts } = setup({ [SERVER]: down, [VERCEL]: async (r) => ok(await r.json()) });
    const req = new Request(`${SERVER}/v1/portal/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    const res = await f.fetch(req);
    expect(await res.json()).toEqual({ a: 1 });
    // The write, the health check, then the write again elsewhere.
    expect(hosts()).toEqual([SERVER, SERVER, VERCEL]);
    expect(new URL(seen[1]!.url).pathname).toBe('/health');
    expect(seen[2]!.method).toBe('POST');
  });

  it("doesn't resend a write the primary may have handled", async () => {
    let calls = 0;
    const flaky: Handler = (req) => {
      if (new URL(req.url).pathname === '/health') return ok();
      calls++;
      throw new TypeError('connection reset');
    };
    const { f, hosts } = setup({ [SERVER]: flaky, [VERCEL]: () => ok() });
    await expect(
      f.fetch(new Request(`${SERVER}/x`, { method: 'POST', body: 'b' })),
    ).rejects.toThrow('connection reset');
    expect(calls).toBe(1);
    expect(hosts()).toEqual([SERVER, SERVER]);
    expect(f.activeUrl()).toBe(SERVER);

    // A proxy error page with a healthy primary is returned as is.
    const page: Handler = (req) =>
      new URL(req.url).pathname === '/health' ? ok() : new Response('bad gateway', { status: 502 });
    const p = setup({ [SERVER]: page, [VERCEL]: () => ok() });
    expect((await p.f.fetch(new Request(`${SERVER}/x`, { method: 'DELETE' }))).status).toBe(502);
  });

  it('returns the last answer or error when every address fails', async () => {
    const pages = setup({ [SERVER]: tunnelDown, [VERCEL]: tunnelDown });
    expect((await pages.f.fetch(new Request(`${SERVER}/x`))).status).toBe(530);
    const none = setup({});
    await expect(none.f.fetch(new Request(`${SERVER}/x`))).rejects.toThrow('Failed to fetch');
    // Only addresses that were skipped get marked down; the last one is still tried.
    expect(none.f.activeUrl()).toBe(VERCEL);
  });

  it('with every address marked down, checks the primary first and uses it once it answers', async () => {
    const { f, storage, seen } = setup({ [SERVER]: () => ok(), [VERCEL]: () => ok() });
    const later = Date.now() + 60_000;
    storage.setItem('eventkit:api-down', JSON.stringify({ [SERVER]: later, [VERCEL]: later }));
    expect(f.activeUrl()).toBe(SERVER);
    await f.fetch(new Request(`${SERVER}/x`));
    expect(seen.map((r) => r.url)).toEqual([`${SERVER}/health`, `${SERVER}/x`]);
    expect(JSON.parse(storage.getItem('eventkit:api-down')!)).toEqual({ [VERCEL]: later });
  });

  it('passes on a request the caller cancelled', async () => {
    const controller = new AbortController();
    const cancel: Handler = () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    const { f, hosts } = setup({ [SERVER]: cancel, [VERCEL]: () => ok() });
    await expect(
      f.fetch(new Request(`${SERVER}/x`, { signal: controller.signal })),
    ).rejects.toThrow('aborted');
    expect(hosts()).toEqual([SERVER]);
  });

  it('leaves requests to other hosts alone', async () => {
    const { f, hosts } = setup({ 'https://bucket.test': () => ok() });
    await f.fetch(new Request('https://bucket.test/file.png'));
    expect(hosts()).toEqual(['https://bucket.test']);
  });

  it('goes back to the primary as soon as its /health answers, checking at most every 5 s', async () => {
    let t = 1_000_000;
    let serverUp = false;
    const net = network({
      [SERVER]: (req) => {
        if (!serverUp) throw new TypeError('Failed to fetch');
        return ok({ from: 'server', path: new URL(req.url).pathname });
      },
      [VERCEL]: () => ok({ from: 'vercel' }),
    });
    const f = createFailoverFetch([SERVER, VERCEL], {
      fetch: net.fetch,
      storage: memoryStorage(),
      now: () => t,
    });
    const from = async () =>
      ((await (await f.fetch(new Request(`${SERVER}/x`))).json()) as { from: string }).from;

    expect(await from()).toBe('vercel'); // server tried, failed, marked down
    t += 1_000;
    expect(await from()).toBe('vercel'); // the failure is a fresh check: no /health yet
    t += 5_000;
    expect(await from()).toBe('vercel'); // checked /health: still down
    expect(net.seen.filter((r) => r.url === `${SERVER}/health`)).toHaveLength(1);

    serverUp = true;
    expect(await from()).toBe('vercel'); // within 5 s of that check: not asked again
    t += 5_000;
    expect(await from()).toBe('server'); // checked, back: straight to the server
    expect(f.activeUrl()).toBe(SERVER);
    expect(await from()).toBe('server');
    expect(net.seen.filter((r) => r.url === `${SERVER}/health`)).toHaveLength(2);
  });

  it('shares one check between requests sent together', async () => {
    let t = 1_000_000;
    const net = network({ [SERVER]: down, [VERCEL]: () => ok() });
    const f = createFailoverFetch([SERVER, VERCEL], {
      fetch: net.fetch,
      storage: null,
      now: () => t,
    });
    await f.fetch(new Request(`${SERVER}/x`));
    t += 10_000;
    await Promise.all([1, 2, 3].map(() => f.fetch(new Request(`${SERVER}/x`))));
    expect(net.seen.filter((r) => r.url === `${SERVER}/health`)).toHaveLength(1);
  });

  it('shares the down mark through storage, and uses the primary unchecked once the mark expires', async () => {
    let t = 1_000_000;
    const now = () => t;
    const net = network({ [SERVER]: down, [VERCEL]: () => ok() });
    const storage = memoryStorage();
    const first = createFailoverFetch([SERVER, VERCEL], { fetch: net.fetch, storage, now });
    await first.fetch(new Request(`${SERVER}/x`));

    // Another tab, or the page after a reload: it checks before using the server.
    const second = createFailoverFetch([SERVER, VERCEL], { fetch: net.fetch, storage, now });
    expect(second.activeUrl()).toBe(VERCEL);
    await second.fetch(new Request(`${SERVER}/x`));
    expect(net.seen.at(-2)!.url).toBe(`${SERVER}/health`);
    expect(net.seen.at(-1)!.url).toBe(`${VERCEL}/x`);
    t += 60_001;
    expect(second.activeUrl()).toBe(SERVER);
  });

  it('works without storage, or with storage that throws or holds junk', async () => {
    const net = network({ [SERVER]: down, [VERCEL]: () => ok() });
    const broken = {
      getItem: () => 'not json',
      setItem: () => {
        throw new Error('quota');
      },
    };
    const f = createFailoverFetch([SERVER, VERCEL], { fetch: net.fetch, storage: broken });
    await f.fetch(new Request(`${SERVER}/x`));
    expect(f.activeUrl()).toBe(VERCEL);

    const nullJson = createFailoverFetch([SERVER], {
      storage: { getItem: () => 'null', setItem() {} },
    });
    expect(nullJson.activeUrl()).toBe(SERVER);

    vi.stubGlobal('localStorage', undefined);
    expect(createFailoverFetch([SERVER]).activeUrl()).toBe(SERVER);
    vi.stubGlobal('localStorage', memoryStorage());
    expect(createFailoverFetch([SERVER]).activeUrl()).toBe(SERVER);
    vi.unstubAllGlobals();
    // A browser that blocks storage throws on access.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(createFailoverFetch([SERVER]).activeUrl()).toBe(SERVER);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('uses the global fetch by default', async () => {
    const fetch = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetch);
    await createFailoverFetch([SERVER, VERCEL], { storage: null }).fetch(
      new Request(`${SERVER}/x`),
    );
    expect(fetch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('createEventKit with two addresses', () => {
  it('fails over transparently and reports the active address', async () => {
    const net = network({ [SERVER]: down, [VERCEL]: () => ok({ status: 'ok' }) });
    vi.stubGlobal('localStorage', memoryStorage());
    const ek = createEventKit({
      apiUrl: `${SERVER}, ${VERCEL}/`,
      apiKey: 'k',
      fetch: net.fetch as unknown as typeof fetch,
    });
    expect(await ek.health()).toEqual({ status: 'ok' });
    expect(net.hosts()).toEqual([SERVER, VERCEL]);
    vi.unstubAllGlobals();
  });
});

describe('createTransport.apiUrl', () => {
  it('is the one address, or the active one of several', async () => {
    const session = new Session(memorySession());
    expect(createTransport({ apiUrl: `${SERVER}/`, apiKey: 'k', session }).apiUrl).toBe(SERVER);
    expect(createTransport({ apiUrl: '', apiKey: 'k', session }).apiUrl).toBe('');

    const net = network({ [SERVER]: down, [VERCEL]: () => ok({ status: 'ok' }) });
    vi.stubGlobal('localStorage', memoryStorage());
    const t = createTransport({
      apiUrl: `${SERVER},${VERCEL}`,
      apiKey: 'k',
      session,
      fetch: net.fetch as unknown as typeof fetch,
    });
    expect(t.apiUrl).toBe(SERVER);
    await t.call(t.api.GET('/health'));
    expect(t.apiUrl).toBe(VERCEL);
    vi.unstubAllGlobals();
  });
});
