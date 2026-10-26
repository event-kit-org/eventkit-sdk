import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPushHandlers } from '../src/sw';
import { client } from './mock';

afterEach(() => vi.unstubAllGlobals());

function browser(permission = 'granted', existing: unknown = null) {
  const unsubscribe = vi.fn(async () => true);
  const subscription = {
    endpoint: 'https://push.test/1',
    unsubscribe,
    toJSON: () => ({ endpoint: 'https://push.test/1', keys: { p256dh: 'p', auth: 'a' } }),
  };
  const subscribe = vi.fn(async () => subscription);
  const getSubscription = vi.fn(async () => existing);
  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }) },
  });
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => permission) });
  return { subscribe, getSubscription, subscription, unsubscribe };
}

describe('push', () => {
  it('enables: permission, subscribe with the API key, register the device', async () => {
    const b = browser();
    const { ek, mock } = client();
    mock.on('GET /v1/push/config', () => ({ enabled: true, publicKey: 'AQAB' }));
    expect(ek.push.isSupported()).toBe(true);
    await ek.push.enable();
    expect(b.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 0, 1]),
    });
    expect(mock.last()).toMatchObject({
      method: 'PUT',
      path: '/v1/push/subscriptions',
      body: { endpoint: 'https://push.test/1', keys: { p256dh: 'p', auth: 'a' } },
    });
  });

  it('reuses an existing subscription; disable unregisters it', async () => {
    const b = browser('granted');
    b.getSubscription.mockResolvedValue(b.subscription);
    const { ek, mock } = client();
    mock.on('GET /v1/push/config', () => ({ enabled: true, publicKey: 'AQAB' }));
    await ek.push.enable();
    expect(b.subscribe).not.toHaveBeenCalled();
    await ek.push.disable();
    expect(mock.last()).toMatchObject({
      method: 'DELETE',
      body: { endpoint: 'https://push.test/1' },
    });
    expect(b.unsubscribe).toHaveBeenCalled();
    b.getSubscription.mockResolvedValue(null);
    const before = mock.calls.length;
    await ek.push.disable();
    expect(mock.calls.length).toBe(before);
  });

  it('refuses without browser support, without API push, or when blocked', async () => {
    const { ek, mock } = client();
    vi.stubGlobal('navigator', {});
    expect(ek.push.isSupported()).toBe(false);
    await expect(ek.push.enable()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await ek.push.disable();
    browser('denied');
    mock.on('GET /v1/push/config', () => ({ enabled: false, publicKey: null }));
    await expect(ek.push.enable()).rejects.toThrow('not set up');
    mock.on('GET /v1/push/config', () => ({ enabled: true, publicKey: 'AQAB' }));
    await expect(ek.push.enable()).rejects.toThrow('blocked');
  });
});

describe('service worker handlers', () => {
  function sw() {
    const handlers = new Map<string, (e: unknown) => void>();
    const shown: { title: string; options: NotificationOptions }[] = [];
    const opened: string[] = [];
    const scope = {
      addEventListener: (n: string, f: (e: unknown) => void) => handlers.set(n, f),
      registration: {
        showNotification: async (title: string, options: NotificationOptions) => {
          shown.push({ title, options });
        },
      },
      clients: { openWindow: async (u: string) => opened.push(u) },
    };
    const waits: Promise<unknown>[] = [];
    const fire = async (name: string, event: object) => {
      handlers.get(name)!({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { scope: scope as unknown as ServiceWorkerGlobalScope, shown, opened, fire };
  }
  const data = (payload: unknown) => ({
    json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
    text: () => String(payload),
  });

  it('shows the notification and opens the page the club maps it to', async () => {
    const s = sw();
    registerPushHandlers(s.scope, {
      urlFor: (p) => `/updates/${p.notificationId}`,
      icon: '/i.png',
    });
    await s.fire('push', {
      data: data({ title: 'Lunch', body: 'Hall B', tag: 'n1', notificationId: 'n1' }),
    });
    expect(s.shown[0]).toEqual({
      title: 'Lunch',
      options: { body: 'Hall B', tag: 'n1', icon: '/i.png', data: { url: '/updates/n1' } },
    });
    const close = vi.fn();
    await s.fire('notificationclick', { notification: { close, data: { url: '/updates/n1' } } });
    expect(close).toHaveBeenCalled();
    expect(s.opened).toEqual(['/updates/n1']);
  });

  it('falls back to the payload url, plain text and no data', async () => {
    const s = sw();
    registerPushHandlers(s.scope);
    await s.fire('push', { data: data({ url: '/events/e/notifications' }) });
    expect(s.shown[0]).toEqual({
      title: 'eventKit',
      options: { body: undefined, data: { url: '/events/e/notifications' } },
    });
    await s.fire('push', { data: data('not json {') });
    expect(s.shown[1]!.options).toMatchObject({ body: 'not json {', data: { url: '/' } });
    await s.fire('push', {});
    expect(s.shown[2]!.options.data).toEqual({ url: '/' });
    await s.fire('notificationclick', { notification: { close: () => {}, data: undefined } });
    expect(s.opened).toEqual(['/']);
  });
});
