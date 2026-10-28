import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventKit,
  EventKitError,
  fieldErrors,
  isEventKitError,
  localStorageSession,
  memorySession,
  DEFAULT_PORTAL_PATHS,
  parseLink,
  portalUrl,
} from '../src';
import { API, apiError, client, EVENT, json, KEY, png } from './mock';

afterEach(() => vi.unstubAllGlobals());

describe('requests', () => {
  it('send the API key always, and the token once signed in', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/auth/login', () => ({ user: { id: 'u' }, token: { accessToken: 'tok' } }));
    await ek.console.auth.me();
    expect(mock.last().headers.get('x-api-key')).toBe(KEY);
    expect(mock.last().headers.get('authorization')).toBeNull();
    await ek.console.auth.login({ email: 'a@b.co', password: 'password1' });
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
    await event.createStaffLink({ role: 'judge', password: 'judges-only', label: 'Judges' });
    expect(mock.last().body).toEqual({ role: 'judge', password: 'judges-only', label: 'Judges' });
    await event.createRegistrationLink({ label: 'Instagram' });
    expect(mock.last().body).toEqual({ role: 'participant', label: 'Instagram' });
    await event.setPortal({
      url: 'https://machzero.vercel.app',
      paths: { register: '/join/{token}' },
    });
    expect(mock.last().body).toEqual({
      portalUrl: 'https://machzero.vercel.app',
      portalPaths: { register: '/join/{token}' },
    });
    await event.setPortal({ url: null });
    expect(mock.last().body).toEqual({ portalUrl: null });
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
    mock.on('POST /v1/events/:id/teams/:t/confirm', () =>
      json({ error: { code: 'NOT_ENOUGH_PLACES', message: 'Full.', details: { max: 4 } } }, 409),
    );
    const err = await event.teams.confirm('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventKitError);
    expect(err).toMatchObject({
      status: 409,
      code: 'NOT_ENOUGH_PLACES',
      message: 'Full.',
      details: { max: 4 },
    });
    expect(isEventKitError(err)).toBe(true);
    expect(isEventKitError(err, 'NOT_ENOUGH_PLACES', 'TEAM_SIZE')).toBe(true);
    expect(isEventKitError(err, 'TEAM_SIZE')).toBe(false);
    expect(isEventKitError(new Error('x'))).toBe(false);
  });

  it('fall back when the body is not an API error, and on network failures', async () => {
    const { ek, mock } = client();
    mock.on('GET /v1/auth/me', () => new Response('<html>blocked</html>', { status: 429 }));
    mock.on('GET /v1/events', () => new Response(null, { status: 502 }));
    await expect(ek.console.events.mine()).rejects.toMatchObject({
      status: 502,
      code: 'UNKNOWN_ERROR',
    });
    await expect(ek.console.auth.me()).rejects.toMatchObject({
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
    await expect(ek.console.auth.me()).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
    mock.on('POST /v1/auth/login', () => apiError(401, 'INVALID_CREDENTIALS'));
    await expect(ek.console.auth.login({ email: 'a@b.co', password: 'x' })).rejects.toThrow();
    expect(ek.session.token).toBe('old');
    mock.on('GET /v1/auth/me', () => apiError(401, 'UNAUTHORIZED'));
    await expect(ek.console.auth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
    await ek.console.auth.signup({ email: 'a@b.co', name: 'A', password: 'password1' });
    expect(ek.session.token).toBe('new');
    ek.console.auth.logout();
    ek.console.auth.logout();
    off();
    ek.session.set('again');
    expect(seen).toEqual([true, false]);
  });

  it('changing or resetting a password keeps the fresh token; deleting the account signs out', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/auth/password', () => ({ user: {}, token: { accessToken: 'changed' } }));
    mock.on('POST /v1/auth/password/reset', () => ({ user: {}, token: { accessToken: 'reset' } }));
    mock.on('DELETE /v1/auth/me', () => new Response(null, { status: 204 }));
    await ek.portal.changePassword('old-password', 'new-password');
    expect(ek.session.token).toBe('changed');
    await ek.console.auth.resetPassword('tok', 'newer-password');
    expect(ek.session.token).toBe('reset');
    await ek.console.auth.deleteAccount('newer-password');
    expect(ek.session.token).toBeNull();
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

describe('the portal', () => {
  it('reads portal links, including overridden paths', () => {
    expect(parseLink('https://club.site/register/abc')).toEqual({ kind: 'register', token: 'abc' });
    expect(parseLink('/staff/s%20t/')).toEqual({ kind: 'staff', token: 's t' });
    expect(parseLink('/me/ek_1?x=1#y')).toEqual({ kind: 'me', token: 'ek_1' });
    expect(parseLink('/elsewhere')).toBeNull();
    const paths = { ...DEFAULT_PORTAL_PATHS, register: '/join/{token}/start' };
    expect(parseLink('/join/abc/start', paths)).toEqual({ kind: 'register', token: 'abc' });
    expect(portalUrl('https://club.site/', '/me/{token}', 'a b')).toBe(
      'https://club.site/me/a%20b',
    );
  });

  it('registers a team, uploading the receipt first through the registration link', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/portal/uploads', () =>
      json(
        {
          key: 'events/e/pending/l/k.png',
          url: 'https://bucket.test/k',
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
        },
        201,
      ),
    );
    mock.on('PUT /k', () => new Response(null));
    const members = [{ name: 'Asha', email: 'a@x.co' }];
    await ek.portal.register({ linkToken: 'reg', team: { name: 'T' }, members, receipt: png(20) });
    const [ticket, , submit] = mock.calls;
    expect(ticket!.body).toEqual({ linkToken: 'reg', contentType: 'image/png', size: 20 });
    expect(submit!.body).toEqual({
      linkToken: 'reg',
      team: { name: 'T' },
      members,
      receiptKey: 'events/e/pending/l/k.png',
    });
    await ek.portal.register({ linkToken: 'reg', team: { name: 'U' }, members, leaderIndex: 0 });
    expect(mock.last().body).toEqual({
      linkToken: 'reg',
      team: { name: 'U' },
      members,
      leaderIndex: 0,
    });
  });

  it('opens a personal link from the address bar, keeps the session and strips the token', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/portal/access', () => ({
      session: { accessToken: 'participant' },
      me: { name: 'Asha' },
    }));
    const replaceState = vi.fn();
    const me = await ek.portal.openSecretLink(undefined, {
      location: { pathname: '/me/ek_secret' } as Location,
      history: { state: null, replaceState } as unknown as History,
    });
    expect(me).toEqual({ name: 'Asha' });
    expect(mock.last().body).toEqual({ token: 'ek_secret' });
    expect(ek.session.token).toBe('participant');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/me');
    await ek.portal.me.get();
    expect(mock.last().headers.get('authorization')).toBe('Bearer participant');

    // A path at the root strips to "/".
    await ek.portal.openSecretLink(undefined, {
      location: { pathname: '/ek_root' } as Location,
      history: { state: 1, replaceState } as unknown as History,
      paths: { ...DEFAULT_PORTAL_PATHS, me: '/{token}' },
    });
    expect(replaceState).toHaveBeenLastCalledWith(1, '', '/');
    // A token given directly needs no address bar.
    await ek.portal.openSecretLink('ek_direct');
    expect(mock.last().body).toEqual({ token: 'ek_direct' });
    await expect(
      ek.portal.openSecretLink(undefined, { location: { pathname: '/register/x' } as Location }),
    ).rejects.toMatchObject({ code: 'LINK_NOT_FOUND' });
  });

  it('resetting the link swaps the session; staff sign up and sign in; logout forgets', async () => {
    const { ek, mock } = client();
    mock.on('POST /v1/portal/me/access/reset', () => ({
      link: { token: 'ek_new', url: null },
      session: { accessToken: 'fresh' },
    }));
    expect(await ek.portal.me.resetLink()).toEqual({ token: 'ek_new', url: null });
    expect(ek.session.token).toBe('fresh');
    mock.on('POST /v1/portal/staff/signup', () =>
      json({ user: {}, role: 'judge', token: { accessToken: 'staff' } }, 201),
    );
    await ek.portal.staff.signup({
      linkToken: 's',
      linkPassword: 'p',
      name: 'J',
      email: 'j@x.co',
      password: 'password1',
    });
    expect(ek.session.token).toBe('staff');
    mock.on('POST /v1/portal/login', () => ({
      user: {},
      role: 'admin',
      token: { accessToken: 'owner' },
    }));
    await ek.portal.login('o@x.co', 'password1');
    expect(ek.session.token).toBe('owner');
    ek.portal.logout();
    expect(ek.session.isSignedIn).toBe(false);
  });

  it('the leader pays through their link; participants page their feed', async () => {
    const { ek, mock } = client({ session: memorySession('participant') });
    mock.on('POST /v1/portal/me/uploads', () =>
      json(
        {
          key: 'k2',
          url: 'https://bucket.test/k2',
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
        },
        201,
      ),
    );
    mock.on('PUT /k2', () => new Response(null));
    await ek.portal.me.team.payReceipt(png(8));
    expect(mock.last().body).toEqual({ receiptKey: 'k2' });
    mock.on('GET /v1/portal/me/notifications', (c) =>
      new URL(c.url).searchParams.get('before') ? [] : [{ id: 'n1', sentAt: 'x' }],
    );
    const ids: string[] = [];
    for await (const n of ek.portal.me.notifications.all({ pageSize: 1, channelId: 'c' }))
      ids.push(n.id);
    expect(ids).toEqual(['n1']);
    expect(new URL(mock.last().url).searchParams.get('channelId')).toBe('c');
    for await (const n of ek.portal.me.notifications.all()) ids.push(n.id);
    expect(new URL(mock.last().url).searchParams.get('limit')).toBe('50');
  });
});
