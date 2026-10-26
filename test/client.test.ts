import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventKit,
  EventKitError,
  fieldErrors,
  isEventKitError,
  localStorageSession,
  memorySession,
} from '../src';
import { API, apiError, client, EVENT, json, KEY } from './mock';

afterEach(() => vi.unstubAllGlobals());

describe('requests', () => {
  it('send the API key always, and the token once signed in', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/auth/login', () => ({ user: { id: 'u' }, token: { accessToken: 'tok' } }));
    await ek.auth.me();
    expect(mock.last().headers.get('x-api-key')).toBe(KEY);
    expect(mock.last().headers.get('authorization')).toBeNull();
    await ek.auth.login({ email: 'a@b.co', password: 'password1' });
    expect(ek.session.isSignedIn).toBe(true);
    await ek.event().get();
    expect(mock.last().url).toBe(`${API}/v1/events/${EVENT}`);
    expect(mock.last().headers.get('authorization')).toBe('Bearer tok');
    // Only these headers: anything else would fail the API's CORS preflight.
    const custom = [...mock.last().headers.keys()].filter(
      (h) => !['x-api-key', 'authorization', 'content-type'].includes(h),
    );
    expect(custom).toEqual([]);
  });

  it('pass query strings and bodies', async () => {
    const { event, mock } = client();
    await event.members.list('judge');
    expect(new URL(mock.last().url).search).toBe('?role=judge');
    await event.payments.list('pending');
    expect(new URL(mock.last().url).search).toBe('?status=pending');
    await event.payments.list();
    expect(new URL(mock.last().url).search).toBe('');
    await event.myTeam.invite('x@y.co', { f: 'v' });
    expect(mock.last().body).toEqual({ email: 'x@y.co', answers: { f: 'v' } });
    await event.attendance.mark('qr', false);
    expect(mock.last().body).toEqual({ qrToken: 'qr', attending: false });
  });

  it('trim a trailing slash from the API URL and use the global fetch by default', async () => {
    const fetchSpy = vi.fn(async () => json({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);
    const ek = createEventKit({ apiUrl: `${API}///`, apiKey: KEY });
    await ek.health();
    expect((fetchSpy.mock.calls[0] as unknown as [Request])[0].url).toBe(`${API}/health`);
  });

  it('pages through the whole notification feed', async () => {
    const { event, mock } = client();
    const page = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `n${start + i}`,
        sentAt: `2026-10-31T0${start + i}:00:00.000Z`,
      }));
    mock.on('GET /v1/events/:id/notifications', (c) => {
      const before = new URL(c.url).searchParams.get('before');
      return before ? page(1, 3) : page(2, 1);
    });
    const ids: string[] = [];
    for await (const n of event.notifications.all({ pageSize: 2, channelId: 'c' })) ids.push(n.id);
    expect(ids).toEqual(['n1', 'n2', 'n3']);
    expect(new URL(mock.last().url).searchParams.get('before')).toBe('2026-10-31T02:00:00.000Z');
    expect(new URL(mock.last().url).searchParams.get('channelId')).toBe('c');
    mock.on('GET /v1/events/:id/notifications', () => []);
    for await (const n of event.notifications.all()) ids.push(n.id);
    expect(new URL(mock.last().url).searchParams.get('limit')).toBe('50');
    await event.notifications.feed({ limit: 5 });
    expect(new URL(mock.last().url).searchParams.get('limit')).toBe('5');
  });

  it('reuse one event client per id, and need an id', () => {
    const { ek } = client();
    expect(ek.event()).toBe(ek.event(EVENT));
    expect(ek.event('other').id).toBe('other');
    const noDefault = createEventKit({ apiUrl: API, apiKey: KEY, fetch: async () => json({}) });
    expect(() => noDefault.event()).toThrow(expect.objectContaining({ code: 'NO_EVENT_ID' }));
  });
});

describe('errors', () => {
  it('carry the API code, message and details', async () => {
    const { event, mock } = client();
    mock.on('POST /v1/events/:id/my-team/invites', () =>
      json({ error: { code: 'TEAM_FULL', message: 'Full.', details: { max: 4 } } }, 409),
    );
    const err = await event.myTeam.invite('x@y.co').catch((e) => e);
    expect(err).toBeInstanceOf(EventKitError);
    expect(err).toMatchObject({
      status: 409,
      code: 'TEAM_FULL',
      message: 'Full.',
      details: { max: 4 },
    });
    expect(isEventKitError(err)).toBe(true);
    expect(isEventKitError(err, 'TEAM_FULL', 'TEAM_LOCKED')).toBe(true);
    expect(isEventKitError(err, 'TEAM_LOCKED')).toBe(false);
    expect(isEventKitError(new Error('x'))).toBe(false);
  });

  it('fall back when the body is not an API error, and on network failures', async () => {
    const { ek, mock } = client();
    mock.on('GET /v1/auth/me', () => new Response('<html>blocked</html>', { status: 429 }));
    mock.on('GET /v1/events', () => new Response(null, { status: 502 }));
    await expect(ek.events.mine()).rejects.toMatchObject({ status: 502, code: 'UNKNOWN_ERROR' });
    await expect(ek.auth.me()).rejects.toMatchObject({
      status: 429,
      code: 'UNKNOWN_ERROR',
      message: 'Request failed (429).',
    });
    const down = createEventKit({
      apiUrl: API,
      apiKey: KEY,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.health()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('a rejected token signs out; a bad API key or wrong password does not', async () => {
    const { ek, mock } = client({ session: memorySession('old') });
    const changes: boolean[] = [];
    ek.session.onChange((s) => changes.push(s));
    mock.on('GET /v1/auth/me', () => apiError(401, 'API_KEY_INVALID'));
    await expect(ek.auth.me()).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
    mock.on('POST /v1/auth/login', () => apiError(401, 'INVALID_CREDENTIALS'));
    await expect(ek.auth.login({ email: 'a@b.co', password: 'x' })).rejects.toThrow();
    expect(ek.session.token).toBe('old');
    mock.on('GET /v1/auth/me', () => apiError(401, 'UNAUTHORIZED'));
    await expect(ek.auth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(ek.session.isSignedIn).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('fieldErrors maps details by path', () => {
    const e = new EventKitError(400, 'INVALID_ANSWERS', 'Bad', [
      { path: '/answers/f1', message: 'Required' },
      { path: '/memberAnswers/f2', message: 'Too long' },
      { nope: true },
    ]);
    expect(fieldErrors(e, '/answers')).toEqual({ f1: 'Required' });
    expect(fieldErrors(e)).toEqual({ '/answers/f1': 'Required', '/memberAnswers/f2': 'Too long' });
    expect(fieldErrors(new Error('x'))).toEqual({});
    expect(fieldErrors(new EventKitError(400, 'X', 'x', 'not a list'))).toEqual({});
  });
});

describe('sessions', () => {
  it('signup and login store the token; logout forgets it', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/auth/signup', () => ({ user: {}, token: { accessToken: 'new' } }));
    const seen: boolean[] = [];
    const off = ek.session.onChange((s) => seen.push(s));
    await ek.auth.signup({ email: 'a@b.co', name: 'A', password: 'password1' });
    expect(ek.session.token).toBe('new');
    ek.auth.logout();
    ek.auth.logout();
    off();
    ek.session.set('again');
    expect(seen).toEqual([true, false]);
  });

  it('localStorageSession persists, and falls back to memory without storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    const s = localStorageSession('k');
    s.set('t1');
    expect(store.get('k')).toBe('t1');
    expect(localStorageSession('k').get()).toBe('t1');
    s.set(null);
    expect(store.has('k')).toBe(false);

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const guarded = localStorageSession();
    guarded.set('mem');
    expect(guarded.get()).toBe('mem');

    vi.stubGlobal('localStorage', undefined);
    const none = localStorageSession();
    none.set('x');
    expect(none.get()).toBe('x');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    const blocked = localStorageSession();
    blocked.set('y');
    expect(blocked.get()).toBe('y');
    Reflect.deleteProperty(globalThis, 'localStorage');
  });
});

describe('links', () => {
  it('canUse refuses someone who already has a role, except a participant on a participant link', () => {
    const { ek } = client();
    const p = (role: string, yourRole: string | null) => ({ role, yourRole }) as never;
    expect(ek.invites.canUse(p('volunteer', null))).toBe(true);
    expect(ek.invites.canUse(p('participant', 'participant'))).toBe(true);
    expect(ek.invites.canUse(p('volunteer', 'participant'))).toBe(false);
    expect(ek.invites.canUse(p('participant', 'judge'))).toBe(false);
  });

  it('accept and join send answers only when given', async () => {
    const { ek, mock } = client();
    await ek.teamInvites.accept('i', { f: 1 });
    expect(mock.last().body).toEqual({ answers: { f: 1 } });
    await ek.teamLinks.join('t', { f: 'x' });
    expect(mock.last().body).toEqual({ answers: { f: 'x' } });
    await ek.teamLinks.join('t');
    expect(mock.last().body).toEqual({});
  });
});
