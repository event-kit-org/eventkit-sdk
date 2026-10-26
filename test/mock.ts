import { createEventKit, type EventKitOptions } from '../src';

export const API = 'https://api.test';
export const KEY = 'ek_test_key';
export const EVENT = '22222222-2222-4222-8222-222222222222';

export interface Call {
  method: string;
  path: string;
  url: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response> | unknown;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const apiError = (status: number, code: string, message = code) =>
  json({ error: { code, message } }, status);

/**
 * A fake API: records every request and answers from handlers matched by
 * "METHOD /path" (path with `:param` or `*` segments); unmatched requests get 200 {}.
 */
export function mockApi() {
  const calls: Call[] = [];
  const routes: { method: string; re: RegExp; handler: Handler }[] = [];
  const on = (route: string, handler: Handler) => {
    const [method, pattern] = route.split(' ') as [string, string];
    const re = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')}$`);
    routes.unshift({ method, re, handler });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON (an upload)
    }
    const call = {
      method: request.method,
      path: url.pathname,
      url: request.url,
      headers: request.headers,
      body,
    };
    calls.push(call);
    const route = routes.find((r) => r.method === request.method && r.re.test(url.pathname));
    const out = route ? await route.handler(call) : {};
    return out instanceof Response ? out : json(out ?? {});
  };
  return { fetch, calls, on, last: () => calls.at(-1)! };
}

export function client(options: Partial<EventKitOptions> = {}) {
  const mock = mockApi();
  const ek = createEventKit({
    apiUrl: API,
    apiKey: KEY,
    eventId: EVENT,
    fetch: mock.fetch,
    ...options,
  });
  return { ek, mock, event: ek.event() };
}

/** A receipt-shaped file. */
export const png = (size = 12) => new Blob([new Uint8Array(size)], { type: 'image/png' });
