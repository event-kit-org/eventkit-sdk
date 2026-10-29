import { EventKitError } from './errors';
import type { Transport } from './http';
import type { Session } from './session';
import type { Body } from './types';

/**
 * Client (eventKit) accounts: event managers. Volunteers and judges sign in on
 * their event's portal instead (portal.login); participants have no account.
 */
export function authApi(t: Transport, session: Session) {
  return {
    /** Creates a client account and signs in. Password: at least 8 characters. */
    async signup(input: Body<'/v1/auth/signup', 'post'>) {
      const res = await t.call(t.api.POST('/v1/auth/signup', { body: input }));
      session.set(res.token.accessToken);
      return res;
    },
    async login(input: Body<'/v1/auth/login', 'post'>) {
      const res = await t.call(t.api.POST('/v1/auth/login', { body: input }));
      session.set(res.token.accessToken);
      return res;
    },
    /**
     * Forgets the token on this device. The API has no logout route yet (tokens
     * last 7 days); when refresh tokens arrive this will revoke them too.
     */
    logout(): void {
      session.set(null);
    },
    /** The signed-in client (or staff member, on a portal). */
    me: () => t.call(t.api.GET('/v1/auth/me')),
    /**
     * Changes the password. Every other session ends; this device stays signed
     * in with a fresh token. WRONG_PASSWORD, SAME_PASSWORD on mistakes.
     */
    async changePassword(currentPassword: string, newPassword: string) {
      const res = await t.call(
        t.api.POST('/v1/auth/password', { body: { currentPassword, newPassword } }),
      );
      session.set(res.token.accessToken);
      return res;
    },
    /**
     * Emails a link to choose a new password (valid an hour, works once). Says
     * nothing about whether the account exists. RESET_UNAVAILABLE if the server
     * has no email set up.
     */
    forgotPassword: (email: string) =>
      t.call(t.api.POST('/v1/auth/password/forgot', { body: { email } })),
    /** Sets a new password from the emailed link's token, and signs in. RESET_LINK_INVALID otherwise. */
    async resetPassword(token: string, newPassword: string) {
      const res = await t.call(
        t.api.POST('/v1/auth/password/reset', { body: { token, newPassword } }),
      );
      session.set(res.token.accessToken);
      return res;
    },
    /**
     * Deletes the account, confirmed with its password, and signs out.
     * OWNS_EVENTS (details: the events) while it owns any: delete those first.
     */
    async deleteAccount(password: string) {
      await t.call(t.api.DELETE('/v1/auth/me', { body: { password } }));
      session.set(null);
    },
  };
}

/** Events across the account: create one, or list the ones you're in. */
export function eventsApi(t: Transport) {
  return {
    /** The caller becomes the new event's admin. Features start switched off. */
    create: (input: Body<'/v1/events', 'post'>) =>
      t.call(t.api.POST('/v1/events', { body: input })),
    /** Events you belong to, with your role in each. */
    mine: () => t.call(t.api.GET('/v1/events')),
  };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Urgent notifications as web push, for whoever is signed in: `register` and
 * `unregister` say where the device is stored (a staff or client account, or a
 * participant's registration). Needs a service worker on your site that shows
 * them: see `@eventkit-sdk/client/sw`.
 */
export function pushApi(
  t: Transport,
  register: (device: PushDevice) => Promise<unknown>,
  unregister: (endpoint: string) => Promise<unknown>,
) {
  const supported = () =>
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof globalThis.PushManager !== 'undefined' &&
    typeof globalThis.Notification !== 'undefined';

  return {
    /** Whether this browser can receive web push. */
    isSupported: supported,
    /** Whether push is on for the API, and the key browsers subscribe with. */
    config: () => t.call(t.api.GET('/v1/push/config')),
    /** Asks permission, subscribes this device and registers it. Browser only. */
    async enable(): Promise<void> {
      if (!supported()) {
        throw new EventKitError(
          0,
          'NOT_SUPPORTED',
          'This browser cannot receive push notifications.',
        );
      }
      const config = await t.call(t.api.GET('/v1/push/config'));
      if (!config.enabled || !config.publicKey) {
        throw new EventKitError(
          0,
          'NOT_SUPPORTED',
          'Push notifications are not set up for this API.',
        );
      }
      if ((await Notification.requestPermission()) !== 'granted') {
        throw new EventKitError(0, 'NOT_SUPPORTED', 'Notifications are blocked for this site.');
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(config.publicKey),
        }));
      const json = subscription.toJSON() as PushDevice;
      await register({ endpoint: json.endpoint, keys: json.keys });
    },
    /** Stops urgent notifications on this device. */
    async disable(): Promise<void> {
      if (!supported()) return;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      await unregister(subscription.endpoint);
      await subscription.unsubscribe();
    },
  };
}
