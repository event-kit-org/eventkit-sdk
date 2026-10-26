import { EventKitError } from './errors';
import type { Transport } from './http';
import type { Session } from './session';
import type { Body, Schemas } from './types';

type AnswersInput = Record<string, string | number | null>;

/** Signing up, logging in and the signed-in account. */
export function authApi(t: Transport, session: Session) {
  return {
    /** Creates an account and signs in. Password: at least 8 characters. */
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
    me: () => t.call(t.api.GET('/v1/auth/me')),
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

/** Invite links an organiser shares (`/i/{token}` on the hosted site). */
export function invitesApi(t: Transport) {
  const path = (token: string) => ({ params: { path: { token } } });
  return {
    /** No login needed. Signed in, it also returns `yourRole` in the event. */
    preview: (token: string) => t.call(t.api.GET('/v1/invites/{token}', path(token))),
    /**
     * Whether the signed-in caller can use this link: someone who already has a
     * role can't take another (an admin changes roles); a participant may still
     * start a team, e.g. after cancelling.
     */
    canUse(preview: Schemas['InvitePreview']): boolean {
      return (
        preview.yourRole === null ||
        (preview.yourRole === 'participant' && preview.role === 'participant')
      );
    },
    /** Volunteer, judge and admin links, with the password the organiser gave. */
    joinAsStaff: (token: string, password: string) =>
      t.call(t.api.POST('/v1/invites/{token}/join', { ...path(token), body: { password } })),
    /** Participant links: start a team and become its leader (and a participant). */
    startTeam: (
      token: string,
      input: { name: string; answers?: AnswersInput; memberAnswers?: AnswersInput },
    ) => t.call(t.api.POST('/v1/invites/{token}/team', { ...path(token), body: input })),
  };
}

/** Team invitations addressed to you, across events. */
export function teamInvitesApi(t: Transport) {
  const path = (inviteId: string) => ({ params: { path: { inviteId } } });
  return {
    list: () => t.call(t.api.GET('/v1/team-invites')),
    /** Joins the team (and makes you a participant); your other invitations are declined. */
    accept: (inviteId: string, answers?: AnswersInput) =>
      t.call(
        t.api.POST('/v1/team-invites/{inviteId}/accept', {
          ...path(inviteId),
          body: answers ? { answers } : {},
        }),
      ),
    decline: (inviteId: string) =>
      t.call(t.api.POST('/v1/team-invites/{inviteId}/decline', path(inviteId))),
  };
}

/** A team's own join link (`/t/{token}` on the hosted site). */
export function teamLinksApi(t: Transport) {
  const path = (token: string) => ({ params: { path: { token } } });
  return {
    preview: (token: string) => t.call(t.api.GET('/v1/team-links/{token}', path(token))),
    join: (token: string, answers?: AnswersInput) =>
      t.call(
        t.api.POST('/v1/team-links/{token}/join', {
          ...path(token),
          body: answers ? { answers } : {},
        }),
      ),
  };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Urgent notifications as web push. Needs a service worker on your site that
 * shows them: see `@eventkit/sdk/sw`.
 */
export function pushApi(t: Transport) {
  const supported = () =>
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof globalThis.PushManager !== 'undefined' &&
    typeof globalThis.Notification !== 'undefined';

  async function currentSubscription(): Promise<PushSubscription | null> {
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

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
      const json = subscription.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      await t.call(
        t.api.PUT('/v1/push/subscriptions', { body: { endpoint: json.endpoint, keys: json.keys } }),
      );
    },
    /** Stops urgent notifications on this device. */
    async disable(): Promise<void> {
      if (!supported()) return;
      const subscription = await currentSubscription();
      if (!subscription) return;
      await t.call(
        t.api.DELETE('/v1/push/subscriptions', { body: { endpoint: subscription.endpoint } }),
      );
      await subscription.unsubscribe();
    },
  };
}
