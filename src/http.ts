import createClient from 'openapi-fetch';
import { EventKitError } from './errors';
import type { paths } from './schema';
import type { Session } from './session';

export interface TransportOptions {
  apiUrl: string;
  apiKey: string;
  session: Session;
  fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createClient<paths>>;

type ApiResult<T> = { data?: T; error?: unknown; response: Response };

/**
 * The typed HTTP client: every request carries X-Api-Key and, when signed in,
 * the Bearer token. No other headers are added: the API's CORS rules allow only
 * Authorization, Content-Type and X-Api-Key.
 */
export function createTransport(options: TransportOptions) {
  const { session } = options;
  // Resolved per request, so test doubles and late polyfills apply.
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const api = createClient<paths>({
    baseUrl: options.apiUrl.replace(/\/+$/, ''),
    fetch: (request: Request) => doFetch(request),
  });
  api.use({
    onRequest({ request }) {
      request.headers.set('X-Api-Key', options.apiKey);
      const token = session.token;
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
  });

  /** Returns the data, or throws EventKitError. A rejected token signs the user out. */
  async function call<T>(promise: Promise<ApiResult<T>>): Promise<T> {
    let result: ApiResult<T>;
    try {
      result = await promise;
    } catch (e) {
      throw new EventKitError(0, 'NETWORK_ERROR', 'Could not reach the eventKit API.', e);
    }
    const { data, error, response } = result;
    if (response.ok) return data as T;
    // A non-JSON error body (a proxy's HTML page, say) arrives as text.
    const body = (typeof error === 'object' && error !== null ? error : {}) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    const code = body.error?.code ?? 'UNKNOWN_ERROR';
    // Only an invalid user token signs out; API key errors are configuration mistakes.
    if (response.status === 401 && code === 'UNAUTHORIZED') session.set(null);
    throw new EventKitError(
      response.status,
      code,
      body.error?.message ?? `Request failed (${response.status}).`,
      body.error?.details,
    );
  }

  return { api, call, fetch: doFetch, apiUrl: options.apiUrl.replace(/\/+$/, '') };
}

export type Transport = ReturnType<typeof createTransport>;
