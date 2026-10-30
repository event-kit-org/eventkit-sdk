import { EventKitError } from './errors';
import type { Transport } from './http';
import type { Session } from './session';
import type { Body, Query, Schemas } from './types';
import { putFile } from './uploads';

type AnswersInput = Record<string, string | number | string[] | null>;
type Me = '/v1/portal/me';

/** Paths on the portal; the API's defaults, which an event can override. */
export const DEFAULT_PORTAL_PATHS: Schemas['PortalPaths'] = {
  register: '/register/{token}',
  staff: '/staff/{token}',
  me: '/me/{token}',
  notifications: '/notifications',
};

export type PortalLink = { kind: 'register' | 'staff' | 'me'; token: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which kind of link a URL (or path) is on this portal, and its token. Null
 * when it is none of them. `paths`: the event's, from `portal.info()`.
 */
export function parseLink(
  url: string,
  paths: Schemas['PortalPaths'] = DEFAULT_PORTAL_PATHS,
): PortalLink | null {
  const pathname = url.includes('://') ? new URL(url).pathname : url.split(/[?#]/)[0]!;
  for (const kind of ['register', 'staff', 'me'] as const) {
    const [before, after] = paths[kind].split('{token}') as [string, string];
    const match = new RegExp(`^${escape(before)}([^/]+)${escape(after)}/?$`).exec(pathname);
    if (match) return { kind, token: decodeURIComponent(match[1]!) };
  }
  return null;
}

/** Builds a link on the portal: `linkFor(portalUrl, paths.register, token)`. */
export function portalUrl(base: string, path: string, token = ''): string {
  return `${base.replace(/\/+$/, '')}${path.replace('{token}', encodeURIComponent(token))}`;
}

/**
 * What an event's own site (its portal) calls, with the event's API key.
 * Participants have no accounts: the team leader registers everyone at once,
 * and each person comes back through their personal secret link.
 */
export function portalApi(t: Transport, session: Session) {
  const { api, call } = t;
  const at = <X extends object>(path: X) => ({ params: { path } });

  const me = {
    /** Your registration, team and QR token. */
    get: () => call(api.GET('/v1/portal/me')),
    /**
     * Replace your personal link (it leaked, say). The old link and every
     * session made from it stop working; you stay signed in with the new one.
     */
    async resetLink() {
      const res = await call(api.POST('/v1/portal/me/access/reset'));
      session.set(res.session.accessToken);
      return res.link;
    },
    /** confirmed → attending. */
    rsvp: () => call(api.POST('/v1/portal/me/rsvp')),
    /** attending → confirmed, until check-in. */
    unrsvp: () => call(api.POST('/v1/portal/me/unrsvp')),
    /**
     * Cancel your registration (a leader cancels the whole team). `confirm`:
     * the email you registered with, or a phone number you gave.
     */
    cancel: (confirm: string) => call(api.POST('/v1/portal/me/cancel', { body: { confirm } })),
    team: {
      /** Your team. The leader also sees contacts, link activity and payment. */
      get: () => call(api.GET('/v1/portal/me/team')),
      /** Leader: pay after shortlisting or a rejection. Uploads the receipt, then hands it in. */
      async payReceipt(receipt: Blob) {
        const receiptKey = await putFile(t, 'receipt', receipt, (contentType, size) =>
          call(api.POST('/v1/portal/me/uploads', { body: { contentType, size } })),
        );
        return call(api.POST('/v1/portal/me/team/payment-proofs', { body: { receiptKey } }));
      },
      /** Leader: hand the team to another member. `confirm`: your email, or a phone number you gave. */
      handOver: (registrationId: string, confirm: string) =>
        call(api.POST('/v1/portal/me/team/leader', { body: { registrationId, confirm } })),
      /** Leader: a new personal link for a teammate whose link leaked or was lost. */
      reissueMemberLink: (registrationId: string) =>
        call(
          api.POST(
            '/v1/portal/me/team/members/{registrationId}/reissue-link',
            at({ registrationId }),
          ),
        ),
    },
    polls: {
      list: () => call(api.GET('/v1/portal/me/polls')),
      /** Vote, or change your vote, until the poll closes. */
      vote: (pollId: string, optionId: string) =>
        call(
          api.PUT('/v1/portal/me/polls/{pollId}/vote', { ...at({ pollId }), body: { optionId } }),
        ),
    },
    notifications: {
      /** Newest first. Page with `before` = the last item's `sentAt`. */
      feed: (query: { before?: string; channelId?: string; limit?: number } = {}) =>
        call(
          api.GET('/v1/portal/me/notifications', {
            params: { query: query as Query<`${Me}/notifications`, 'get'> },
          }),
        ),
      /** Every notification, newest first, a page at a time. */
      async *all(query: { channelId?: string; pageSize?: number } = {}) {
        const limit = query.pageSize ?? 50;
        let before: string | undefined;
        for (;;) {
          const page = await me.notifications.feed({
            limit,
            ...(before ? { before } : {}),
            ...(query.channelId ? { channelId: query.channelId } : {}),
          });
          yield* page;
          if (page.length < limit) return;
          before = page.at(-1)!.sentAt;
        }
      },
    },
    /** Team totals, once the organiser shows the leaderboard. */
    leaderboard: (roundId?: string) =>
      call(
        api.GET('/v1/portal/me/leaderboard', {
          params: { query: { ...(roundId ? { roundId } : {}) } as never },
        }),
      ),
    submissions: {
      /** Each round's forms: `{round, fields, open, entry}`. */
      list: () => call(api.GET('/v1/portal/me/submissions')),
      /** Save your team's answers (while the submission is open). */
      saveEntry: (
        submissionId: string,
        answers: Body<`${Me}/submissions/{submissionId}/entry`, 'put'>['answers'],
      ) =>
        call(
          api.PUT('/v1/portal/me/submissions/{submissionId}/entry', {
            ...at({ submissionId }),
            body: { answers },
          }),
        ),
    },
    /** Low level: register or remove this device for urgent push (see push.enable). */
    pushDevice: {
      put: (body: Body<`${Me}/push`, 'put'>) => call(api.PUT('/v1/portal/me/push', { body })),
      remove: (endpoint: string) => call(api.DELETE('/v1/portal/me/push', { body: { endpoint } })),
    },
  };

  return {
    /** The event, its registration form and team rules, the portal's paths, places left. */
    info: () => call(api.GET('/v1/portal')),
    /** What a registration or staff link is (before showing its page). */
    previewLink: (token: string) => call(api.GET('/v1/portal/links/{token}', at({ token }))),

    /**
     * Registers the whole team at once through a registration link (no
     * accounts). When the event takes payment at registration, pass the
     * receipt: it is uploaded first. Returns each member's participant ID, QR
     * token and personal link: show them now, they are not shown again.
     */
    async register(input: {
      linkToken: string;
      team: { name: string; answers?: AnswersInput };
      members: { name: string; email: string; answers?: AnswersInput }[];
      /** Which member leads (default 0, the first). */
      leaderIndex?: number;
      receipt?: Blob;
    }) {
      const { receipt, ...body } = input;
      const receiptKey = receipt
        ? await putFile(t, 'receipt', receipt, (contentType, size) =>
            call(
              api.POST('/v1/portal/uploads', {
                body: { linkToken: input.linkToken, contentType, size },
              }),
            ),
          )
        : undefined;
      return call(
        api.POST('/v1/portal/register', { body: receiptKey ? { ...body, receiptKey } : body }),
      );
    },

    /**
     * Opens a personal secret link: swaps its token for a session (kept in the
     * session store) and, in a browser, removes the token from the address bar.
     * Without `token`, reads it from the current URL using the `me` path.
     */
    async openSecretLink(
      token?: string,
      options: { paths?: Schemas['PortalPaths']; location?: Location; history?: History } = {},
    ) {
      const loc = options.location ?? (typeof location === 'undefined' ? undefined : location);
      const paths = options.paths ?? DEFAULT_PORTAL_PATHS;
      const fromUrl = loc ? parseLink(loc.pathname, paths) : null;
      const linkToken = token ?? (fromUrl?.kind === 'me' ? fromUrl.token : undefined);
      if (!linkToken) {
        throw new EventKitError(
          0,
          'LINK_NOT_FOUND',
          'This page has no personal link in its address.',
        );
      }
      const res = await call(api.POST('/v1/portal/access', { body: { token: linkToken } }));
      session.set(res.session.accessToken);
      const hist = options.history ?? (typeof history === 'undefined' ? undefined : history);
      if (hist && fromUrl?.kind === 'me') {
        const clean = paths.me.split('{token}')[0]!.replace(/\/+$/, '') || '/';
        hist.replaceState(hist.state, '', clean);
      }
      return res.me;
    },

    /** The participant's own routes, after openSecretLink. */
    me,

    staff: {
      /**
       * Volunteers and judges: create this event's portal account through a
       * staff link and its password. Signs in.
       */
      async signup(input: Body<'/v1/portal/staff/signup', 'post'>) {
        const res = await call(api.POST('/v1/portal/staff/signup', { body: input }));
        session.set(res.token.accessToken);
        return res;
      },
    },

    /** Sign in on the portal: this event's volunteers and judges, or its owner. */
    async login(email: string, password: string) {
      const res = await call(api.POST('/v1/portal/login', { body: { email, password } }));
      session.set(res.token.accessToken);
      return res;
    },

    /**
     * Staff (and the owner or co-admins) change their password. Every other
     * session ends; this device stays signed in.
     */
    async changePassword(currentPassword: string, newPassword: string) {
      const res = await call(
        api.POST('/v1/auth/password', { body: { currentPassword, newPassword } }),
      );
      session.set(res.token.accessToken);
      return res;
    },

    /** Forgets the session on this device. */
    logout(): void {
      session.set(null);
    },
  };
}

export type PortalApi = ReturnType<typeof portalApi>;
