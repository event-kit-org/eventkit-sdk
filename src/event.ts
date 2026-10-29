import type { Transport } from './http';
import { uploadFile, type UploadPurpose } from './uploads';
import type { Body, EmailKind, Feature, Query, Role } from './types';

type E = '/v1/events/{eventId}';
type Mail = '/v1/events/{eventId}/emails/{kind}';

/**
 * Everything inside one event, for its owner (a client) and its staff
 * (volunteers, judges, signed in on the portal). The API checks the role: a
 * volunteer calling an admin function gets ROLE_FORBIDDEN. Participants use
 * `portal.me` instead.
 */
export function eventApi(t: Transport, eventId: string) {
  const { api, call } = t;
  const at = <X extends object = Record<never, never>>(extra?: X) => ({
    params: { path: { eventId, ...(extra ?? ({} as X)) } },
  });
  const upload = (purpose: UploadPurpose, file: Blob, teamId?: string) =>
    uploadFile(t, eventId, purpose, file, teamId);

  return {
    id: eventId,

    // ------------------------------------------------------------ event
    /** The event and your role in it. */
    get: () => call(api.GET('/v1/events/{eventId}', at())),
    /** Admin. Payment mode, fee and currency lock once anyone has registered. */
    update: (patch: Body<E, 'patch'>) =>
      call(api.PATCH('/v1/events/{eventId}', { ...at(), body: patch })),
    /**
     * Admin: where the event's portal lives, e.g. https://machzero.vercel.app,
     * and optional path overrides (defaults /register/{token}, /staff/{token},
     * /me/{token}, /notifications). Links come back as URLs on it.
     */
    setPortal: (portal: { url: string | null; paths?: Body<E, 'patch'>['portalPaths'] }) =>
      call(
        api.PATCH('/v1/events/{eventId}', {
          ...at(),
          body: { portalUrl: portal.url, ...(portal.paths ? { portalPaths: portal.paths } : {}) },
        }),
      ),
    /**
     * Admin: delete the event for good, with all its teams, registrations, links,
     * polls, judging and staff accounts. Confirm with the event's exact name.
     */
    delete: (confirmName: string) =>
      call(api.DELETE('/v1/events/{eventId}', { ...at(), body: { confirmName } })),
    /** Which features are on. Every member can read this, to hide what's off. */
    features: () => call(api.GET('/v1/events/{eventId}/features', at())),
    /** Admin: switch a feature off, or back on if it was bought. */
    setFeature: (feature: Feature, enabled: boolean) =>
      call(
        api.PATCH('/v1/events/{eventId}/features/{feature}', {
          ...at({ feature }),
          body: { enabled },
        }),
      ),
    /** A short-lived link to the UPI QR image teams pay to. */
    paymentQr: () => call(api.GET('/v1/events/{eventId}/payment-qr', at())),
    /** Admin: upload a new UPI QR image (JPG, PNG or WebP, up to 5 MB). */
    async setPaymentQr(file: Blob) {
      const key = await upload('payment_qr', file);
      return call(api.PUT('/v1/events/{eventId}/payment-qr', { ...at(), body: { key } }));
    },
    /** A short-lived link to the payment instructions file. */
    paymentInstructionsFile: () =>
      call(api.GET('/v1/events/{eventId}/payment-instructions-file', at())),
    /**
     * Admin: upload a payment instructions file (JPG, PNG, WebP or PDF, up to
     * 5 MB), e.g. bank details. Written instructions go in `update({ paymentInstructions })`.
     */
    async setPaymentInstructionsFile(file: Blob) {
      const key = await upload('payment_instructions', file);
      return call(
        api.PUT('/v1/events/{eventId}/payment-instructions-file', { ...at(), body: { key } }),
      );
    },
    /** Admin: remove the payment instructions file. */
    removePaymentInstructionsFile: () =>
      call(api.DELETE('/v1/events/{eventId}/payment-instructions-file', at())),

    // ------------------------------------------------------------ admin setup
    /**
     * Admin: the emails eventKit sends, written your way. A template is a whole
     * HTML document with Mustache variables; build it with `registrationEmail`
     * (from '@eventkit-sdk/client') or write the `{{…}}` yourself. eventKit fills and
     * escapes it when it sends. Buttons are links: mail apps run no scripts.
     */
    emails: {
      /** The current template (eventKit's default until you save one) and its variables. */
      get: (kind: EmailKind) => call(api.GET('/v1/events/{eventId}/emails/{kind}', at({ kind }))),
      /** Save your template. Refused with INVALID_TEMPLATE (each problem in `details`) if it has mistakes. */
      save: (kind: EmailKind, template: Body<Mail, 'put'>) =>
        call(api.PUT('/v1/events/{eventId}/emails/{kind}', { ...at({ kind }), body: template })),
      /** Go back to eventKit's default. */
      reset: (kind: EmailKind) =>
        call(api.DELETE('/v1/events/{eventId}/emails/{kind}', at({ kind }))),
      /**
       * The email filled in with a made-up team on this event. Pass a draft to
       * try changes before saving; parts left out come from the current template.
       */
      preview: (kind: EmailKind, draft?: NonNullable<Body<`${Mail}/preview`, 'post'>>) =>
        call(
          api.POST('/v1/events/{eventId}/emails/{kind}/preview', {
            ...at({ kind }),
            body: draft ?? {},
          }),
        ),
      /** Send that preview to the event owner's email, to see it in a real inbox. */
      sendTest: (kind: EmailKind, draft?: NonNullable<Body<`${Mail}/test`, 'post'>>) =>
        call(
          api.POST('/v1/events/{eventId}/emails/{kind}/test', {
            ...at({ kind }),
            body: draft ?? {},
          }),
        ),
    },

    billing: {
      /** Buy features; an approved purchase switches them on. */
      purchase: (features: Feature[]) =>
        call(api.POST('/v1/events/{eventId}/billing/purchases', { ...at(), body: { features } })),
      /** Participant and volunteer counts (what pricing is based on). */
      usage: () => call(api.GET('/v1/events/{eventId}/billing/usage', at())),
    },
    apiKeys: {
      /** The full key is returned only here, once. It identifies an app; it grants nothing. */
      create: (name: string) =>
        call(api.POST('/v1/events/{eventId}/api-keys', { ...at(), body: { name } })),
      list: () => call(api.GET('/v1/events/{eventId}/api-keys', at())),
      revoke: (keyId: string) =>
        call(api.DELETE('/v1/events/{eventId}/api-keys/{keyId}', at({ keyId }))),
    },
    /**
     * Admin: a registration link on the portal, e.g. https://machzero.vercel.app/register/<token>.
     * Teams register through it. Several can exist (one per channel, say).
     */
    createRegistrationLink: (options: { label?: string; expiresAt?: string } = {}) =>
      call(
        api.POST('/v1/events/{eventId}/invite-links', {
          ...at(),
          body: { role: 'participant', ...options },
        }),
      ),
    /** Admin: a staff link on the portal for volunteers or judges, with a password to share separately. */
    createStaffLink: (options: {
      role: 'volunteer' | 'judge';
      password: string;
      label?: string;
      expiresAt?: string;
    }) => call(api.POST('/v1/events/{eventId}/invite-links', { ...at(), body: options })),
    inviteLinks: {
      /** Low level: registration (role participant) or staff (volunteer, judge; with a password) links. */
      create: (input: Body<`${E}/invite-links`, 'post'>) =>
        call(api.POST('/v1/events/{eventId}/invite-links', { ...at(), body: input })),
      list: () => call(api.GET('/v1/events/{eventId}/invite-links', at())),
      revoke: (linkId: string) =>
        call(api.DELETE('/v1/events/{eventId}/invite-links/{linkId}', at({ linkId }))),
    },
    members: {
      list: (role?: Role) =>
        call(
          api.GET('/v1/events/{eventId}/members', {
            params: { path: { eventId }, query: role ? { role } : {} },
          }),
        ),
      /**
       * Owner: add a co-admin (`admin`: everything but deleting the event,
       * billing, API keys and organisers) or a `reviewer` (teams and payments
       * only), by the email of their eventKit account. ACCOUNT_NOT_FOUND if they
       * haven't signed up yet.
       */
      add: (email: string, role: 'admin' | 'reviewer') =>
        call(api.POST('/v1/events/{eventId}/members', { ...at(), body: { email, role } })),
      /**
       * Switch staff between volunteer and judge, or (owner only) an organiser
       * between admin and reviewer.
       */
      changeRole: (userId: string, role: 'volunteer' | 'judge' | 'admin' | 'reviewer') =>
        call(
          api.PATCH('/v1/events/{eventId}/members/{userId}', { ...at({ userId }), body: { role } }),
        ),
      /**
       * Remove someone: admins remove staff, the owner removes organisers, and
       * anyone but the owner can remove themselves (leave the event).
       */
      remove: (userId: string) =>
        call(api.DELETE('/v1/events/{eventId}/members/{userId}', at({ userId }))),
    },
    /** The registration form: team details and per-member details. */
    fields: {
      list: () => call(api.GET('/v1/events/{eventId}/fields', at())),
      create: (input: Body<`${E}/fields`, 'post'>) =>
        call(api.POST('/v1/events/{eventId}/fields', { ...at(), body: input })),
      update: (fieldId: string, patch: Body<`${E}/fields/{fieldId}`, 'patch'>) =>
        call(
          api.PATCH('/v1/events/{eventId}/fields/{fieldId}', { ...at({ fieldId }), body: patch }),
        ),
      remove: (fieldId: string) =>
        call(api.DELETE('/v1/events/{eventId}/fields/{fieldId}', at({ fieldId }))),
    },
    /** "At least N members with <answer>": check them with checkTeamRules before registering. */
    teamRules: {
      list: () => call(api.GET('/v1/events/{eventId}/team-rules', at())),
      create: (input: Body<`${E}/team-rules`, 'post'>) =>
        call(api.POST('/v1/events/{eventId}/team-rules', { ...at(), body: input })),
      remove: (ruleId: string) =>
        call(api.DELETE('/v1/events/{eventId}/team-rules/{ruleId}', at({ ruleId }))),
    },

    // ------------------------------------------------------------ admin review
    teams: {
      list: () => call(api.GET('/v1/events/{eventId}/teams', at())),
      get: (teamId: string) => call(api.GET('/v1/events/{eventId}/teams/{teamId}', at({ teamId }))),
      /** Pay-after-shortlist events: registered → shortlisted. */
      shortlist: (teamId: string) =>
        call(api.POST('/v1/events/{eventId}/teams/{teamId}/shortlist', at({ teamId }))),
      /** Events without payment: registered → confirmed (refused if places run out). */
      confirm: (teamId: string) =>
        call(api.POST('/v1/events/{eventId}/teams/{teamId}/confirm', at({ teamId }))),
      /**
       * Admin: delete the team for good (registrations, check-ins, votes,
       * receipts, scores) and free its places. Cancelling keeps a record instead.
       */
      delete: (teamId: string) =>
        call(api.DELETE('/v1/events/{eventId}/teams/{teamId}', at({ teamId }))),
    },
    registrations: {
      cancel: (registrationId: string) =>
        call(
          api.POST(
            '/v1/events/{eventId}/registrations/{registrationId}/cancel',
            at({ registrationId }),
          ),
        ),
      /** Undo a cancellation, if places allow. */
      restore: (registrationId: string) =>
        call(
          api.POST(
            '/v1/events/{eventId}/registrations/{registrationId}/restore',
            at({ registrationId }),
          ),
        ),
      /**
       * A new personal link for someone whose link leaked or was lost (check
       * who they are first). The old link and its sessions stop working.
       */
      reissueLink: (registrationId: string) =>
        call(
          api.POST(
            '/v1/events/{eventId}/registrations/{registrationId}/reissue-link',
            at({ registrationId }),
          ),
        ),
      /** A new QR code; the old one stops scanning. */
      rotateQr: (registrationId: string) =>
        call(
          api.POST(
            '/v1/events/{eventId}/registrations/{registrationId}/rotate-qr',
            at({ registrationId }),
          ),
        ),
    },
    payments: {
      list: (status?: Query<`${E}/payment-proofs`, 'get'>['status']) =>
        call(
          api.GET('/v1/events/{eventId}/payment-proofs', {
            params: { path: { eventId }, query: status ? { status } : {} },
          }),
        ),
      /** The team is confirmed (refused with NOT_ENOUGH_PLACES at capacity). */
      approve: (proofId: string) =>
        call(api.POST('/v1/events/{eventId}/payment-proofs/{proofId}/approve', at({ proofId }))),
      /** Attach a receipt for a team (one it sent another way). Uploads, then hands it in. */
      async attachReceipt(teamId: string, receipt: Blob) {
        const receiptKey = await upload('receipt', receipt, teamId);
        return call(
          api.POST('/v1/events/{eventId}/teams/{teamId}/payment-proofs', {
            ...at({ teamId }),
            body: { receiptKey },
          }),
        );
      },
      /** The leader can upload again, for the same amount. */
      reject: (proofId: string, note: string) =>
        call(
          api.POST('/v1/events/{eventId}/payment-proofs/{proofId}/reject', {
            ...at({ proofId }),
            body: { note },
          }),
        ),
    },

    // ------------------------------------------------------------ on site
    checkpoints: {
      list: () => call(api.GET('/v1/events/{eventId}/checkpoints', at())),
      create: (input: Body<`${E}/checkpoints`, 'post'>) =>
        call(api.POST('/v1/events/{eventId}/checkpoints', { ...at(), body: input })),
      update: (checkpointId: string, patch: Body<`${E}/checkpoints/{checkpointId}`, 'patch'>) =>
        call(
          api.PATCH('/v1/events/{eventId}/checkpoints/{checkpointId}', {
            ...at({ checkpointId }),
            body: patch,
          }),
        ),
      remove: (checkpointId: string) =>
        call(api.DELETE('/v1/events/{eventId}/checkpoints/{checkpointId}', at({ checkpointId }))),
    },
    /**
     * One scan, low level: `id` must be a UUID made on the device and reused on
     * retries; `qrToken` may also be a participant ID typed by hand. Prefer
     * createScanner(), which does that for you.
     */
    scan: (input: { id: string; checkpointId: string; qrToken: string }) =>
      call(api.POST('/v1/events/{eventId}/scans', { ...at(), body: input })),
    attendance: {
      /** Staff at the gate: mark someone attending (or not) by their QR code or participant ID. */
      mark: (qrToken: string, attending = true) =>
        call(
          api.POST('/v1/events/{eventId}/attendance', { ...at(), body: { qrToken, attending } }),
        ),
    },

    // ------------------------------------------------------------ polls
    polls: {
      list: () => call(api.GET('/v1/events/{eventId}/polls', at())),
      get: (pollId: string) => call(api.GET('/v1/events/{eventId}/polls/{pollId}', at({ pollId }))),
      /** Admins and volunteers. A food poll needs a default option (`defaultOptionIndex`). */
      create: (input: Body<`${E}/polls`, 'post'>) =>
        call(api.POST('/v1/events/{eventId}/polls', { ...at(), body: input })),
      update: (pollId: string, patch: Body<`${E}/polls/{pollId}`, 'patch'>) =>
        call(api.PATCH('/v1/events/{eventId}/polls/{pollId}', { ...at({ pollId }), body: patch })),
      remove: (pollId: string) =>
        call(api.DELETE('/v1/events/{eventId}/polls/{pollId}', at({ pollId }))),
      /** Always allowed, even after votes. */
      addOption: (pollId: string, label: string) =>
        call(
          api.POST('/v1/events/{eventId}/polls/{pollId}/options', {
            ...at({ pollId }),
            body: { label },
          }),
        ),
      /** Only before anyone votes. */
      renameOption: (pollId: string, optionId: string, label: string) =>
        call(
          api.PATCH('/v1/events/{eventId}/polls/{pollId}/options/{optionId}', {
            ...at({ pollId, optionId }),
            body: { label },
          }),
        ),
      /** Only before anyone votes. */
      removeOption: (pollId: string, optionId: string) =>
        call(
          api.DELETE(
            '/v1/events/{eventId}/polls/{pollId}/options/{optionId}',
            at({ pollId, optionId }),
          ),
        ),
      /** Vote, or change your vote, until the poll closes. */
      vote: (pollId: string, optionId: string) =>
        call(
          api.PUT('/v1/events/{eventId}/polls/{pollId}/vote', {
            ...at({ pollId }),
            body: { optionId },
          }),
        ),
    },

    // ------------------------------------------------------------ notifications
    channels: {
      list: () => call(api.GET('/v1/events/{eventId}/channels', at())),
      /** All four roles means everyone. */
      create: (input: { name: string; audience: Role[] }) =>
        call(api.POST('/v1/events/{eventId}/channels', { ...at(), body: input })),
      update: (channelId: string, patch: { name?: string; audience?: Role[] }) =>
        call(
          api.PATCH('/v1/events/{eventId}/channels/{channelId}', {
            ...at({ channelId }),
            body: patch,
          }),
        ),
      remove: (channelId: string) =>
        call(api.DELETE('/v1/events/{eventId}/channels/{channelId}', at({ channelId }))),
      /** Volunteers send only to channels that include volunteers. Urgent ones are pushed. */
      send: (
        channelId: string,
        input: { title: string; body: string; priority?: 'normal' | 'urgent' },
      ) =>
        call(
          api.POST('/v1/events/{eventId}/channels/{channelId}/notifications', {
            ...at({ channelId }),
            body: input,
          }),
        ),
    },
    notifications: {
      /** Newest first. Page with `before` = the last item's `sentAt`. */
      feed: (query: { before?: string; channelId?: string; limit?: number } = {}) =>
        call(
          api.GET('/v1/events/{eventId}/notifications', {
            params: { path: { eventId }, query: query as Query<`${E}/notifications`, 'get'> },
          }),
        ),
      /** Every notification, newest first, fetched a page at a time. */
      async *all(query: { channelId?: string; pageSize?: number } = {}) {
        const limit = query.pageSize ?? 50;
        let before: string | undefined;
        for (;;) {
          const page = await call(
            api.GET('/v1/events/{eventId}/notifications', {
              params: {
                path: { eventId },
                query: {
                  limit,
                  ...(before ? { before } : {}),
                  ...(query.channelId ? { channelId: query.channelId } : {}),
                } as Query<`${E}/notifications`, 'get'>,
              },
            }),
          );
          yield* page;
          if (page.length < limit) return;
          before = page.at(-1)!.sentAt;
        }
      },
    },

    // ------------------------------------------------------------ judging
    criteria: {
      list: () => call(api.GET('/v1/events/{eventId}/criteria', at())),
      create: (input: Body<`${E}/criteria`, 'post'>) =>
        call(api.POST('/v1/events/{eventId}/criteria', { ...at(), body: input })),
      update: (criterionId: string, patch: Body<`${E}/criteria/{criterionId}`, 'patch'>) =>
        call(
          api.PATCH('/v1/events/{eventId}/criteria/{criterionId}', {
            ...at({ criterionId }),
            body: patch,
          }),
        ),
      remove: (criterionId: string) =>
        call(api.DELETE('/v1/events/{eventId}/criteria/{criterionId}', at({ criterionId }))),
    },
    judging: {
      /** Judges: teams with at least one member checked in, with your own scores. */
      teams: () => call(api.GET('/v1/events/{eventId}/judging/teams', at())),
      /** Each score from 0 to the criterion's maximum. */
      saveScores: (
        teamId: string,
        scores: { criterionId: string; value: number; comment?: string | null }[],
      ) =>
        call(
          api.PUT('/v1/events/{eventId}/judging/teams/{teamId}/scores', {
            ...at({ teamId }),
            body: { scores },
          }),
        ),
    },
    /** Admins and judges always; everyone once the admin shows it (`leaderboardVisible`). */
    leaderboard: () => call(api.GET('/v1/events/{eventId}/leaderboard', at())),

    // ------------------------------------------------------------ files
    uploads: {
      /** Low level: upload the payment QR, or a team's receipt (with teamId), and get its key. */
      upload,
    },
  };
}

export type EventApi = ReturnType<typeof eventApi>;
