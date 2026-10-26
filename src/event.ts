import type { Transport } from './http';
import { uploadFile, type UploadPurpose } from './uploads';
import type { Body, Feature, Query, Role } from './types';

type E = '/v1/events/{eventId}';
type AnswersInput = Record<string, string | number | null>;

/**
 * Everything inside one event. Every call needs a signed-in user with a role in
 * the event, and the API checks that role: a participant calling an admin
 * function gets ROLE_FORBIDDEN.
 */
export function eventApi(t: Transport, eventId: string) {
  const { api, call } = t;
  const at = <X extends object = Record<never, never>>(extra?: X) => ({
    params: { path: { eventId, ...(extra ?? ({} as X)) } },
  });
  const upload = (purpose: UploadPurpose, file: Blob) => uploadFile(t, eventId, purpose, file);

  return {
    id: eventId,

    // ------------------------------------------------------------ event
    /** The event and your role in it. */
    get: () => call(api.GET('/v1/events/{eventId}', at())),
    /** Admin. Payment mode, fee and currency lock once anyone has registered. */
    update: (patch: Body<E, 'patch'>) =>
      call(api.PATCH('/v1/events/{eventId}', { ...at(), body: patch })),
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

    // ------------------------------------------------------------ admin setup
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
    inviteLinks: {
      /** Staff links (volunteer, judge, admin) need a password; participant links have none. */
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
      /** Taking someone out of the participant role works like them cancelling. */
      changeRole: (userId: string, role: Role) =>
        call(
          api.PATCH('/v1/events/{eventId}/members/{userId}', { ...at({ userId }), body: { role } }),
        ),
      /** The last admin can't be removed. */
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

    // ------------------------------------------------------------ participants
    myTeam: {
      get: () => call(api.GET('/v1/events/{eventId}/my-team', at())),
      /** Leader, while forming: rename, or edit team details. */
      update: (patch: { name?: string; answers?: AnswersInput }) =>
        call(api.PATCH('/v1/events/{eventId}/my-team', { ...at(), body: patch })),
      /** Leader: invite by account email (no account: NO_ACCOUNT, ask them to sign up). */
      invite: (email: string, answers?: AnswersInput) =>
        call(
          api.POST('/v1/events/{eventId}/my-team/invites', {
            ...at(),
            body: answers ? { email, answers } : { email },
          }),
        ),
      withdrawInvite: (membershipId: string) =>
        call(
          api.DELETE('/v1/events/{eventId}/my-team/invites/{membershipId}', at({ membershipId })),
        ),
      /** The leader edits leader-filled fields; each member edits their own. */
      updateMember: (membershipId: string, answers: AnswersInput) =>
        call(
          api.PATCH('/v1/events/{eventId}/my-team/members/{membershipId}', {
            ...at({ membershipId }),
            body: { answers },
          }),
        ),
      removeMember: (userId: string) =>
        call(api.DELETE('/v1/events/{eventId}/my-team/members/{userId}', at({ userId }))),
      leave: () => call(api.POST('/v1/events/{eventId}/my-team/leave', at())),
      disband: () => call(api.DELETE('/v1/events/{eventId}/my-team', at())),
      handOver: (userId: string) =>
        call(api.POST('/v1/events/{eventId}/my-team/leader', { ...at(), body: { userId } })),
      /** Leader: a new join link; the old one stops working. */
      resetJoinLink: () => call(api.POST('/v1/events/{eventId}/my-team/join-link/reset', at())),
      /**
       * Leader: submit the team. When the event takes payment at registration,
       * pass the receipt: it is uploaded first, then submitted with the team.
       */
      async register(options: { receipt?: Blob } = {}) {
        const receiptKey = options.receipt ? await upload('receipt', options.receipt) : undefined;
        return call(
          api.POST('/v1/events/{eventId}/my-team/registration', {
            ...at(),
            body: receiptKey ? { receiptKey } : {},
          }),
        );
      },
      /** Leader: pay after a rejection, or after shortlisting (before the payment deadline). */
      async payReceipt(receipt: Blob) {
        const receiptKey = await upload('receipt', receipt);
        return call(
          api.POST('/v1/events/{eventId}/my-team/payment-proofs', {
            ...at(),
            body: { receiptKey },
          }),
        );
      },
    },
    myRegistration: {
      /** Status and `qrToken`: render the token as a QR code for check-in. */
      get: () => call(api.GET('/v1/events/{eventId}/my-registration', at())),
      /** confirmed → attending. */
      rsvp: () => call(api.POST('/v1/events/{eventId}/my-registration/rsvp', at())),
      /** attending → confirmed, until check-in. */
      unrsvp: () => call(api.POST('/v1/events/{eventId}/my-registration/unrsvp', at())),
      /** A leader cancelling cancels the whole team. Not after check-in. */
      cancel: () => call(api.POST('/v1/events/{eventId}/my-registration/cancel', at())),
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
     * retries. Prefer createScanner(), which does that for you.
     */
    scan: (input: { id: string; checkpointId: string; qrToken: string }) =>
      call(api.POST('/v1/events/{eventId}/scans', { ...at(), body: input })),
    attendance: {
      /** Staff at the gate: mark someone attending (or not) by their QR code. */
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
      /** Low level: upload a file and get its key. register/payReceipt/setPaymentQr do this for you. */
      upload,
    },
  };
}

export type EventApi = ReturnType<typeof eventApi>;
