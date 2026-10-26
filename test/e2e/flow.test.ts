/**
 * The whole event, through the devkit only, against a running eventkit-core:
 *   EVENTKIT_API_URL=http://localhost:4000 EVENTKIT_PLATFORM_KEY=... npm run test:e2e
 * Every account is fresh; run it against a development database.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEventKit, type EventKit, isEventKitError } from '../../src';

const apiUrl = process.env.EVENTKIT_API_URL ?? 'http://127.0.0.1:47400';
const platformKey = process.env.EVENTKIT_PLATFORM_KEY ?? 'e2e-platform-key-e2e-platform-key-00';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function person(apiKey: string, eventId?: string, name = 'Test Person'): Promise<EventKit> {
  const ek = createEventKit({ apiUrl, apiKey, ...(eventId ? { eventId } : {}) });
  await ek.auth.signup({ email: `${randomUUID()}@e2e.test`, name, password: 'password123' });
  return ek;
}

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('an event, end to end through the devkit', () => {
  it('setup → teams → payment → RSVP → check-in → polls → notifications → judging', async () => {
    // The organiser sets up on the hosted platform (platform key).
    const admin = await person(platformKey, undefined, 'Organiser');
    expect((await admin.ready()).status).toBe('ok');
    const { event } = await admin.events.create({
      name: 'E2E Hack',
      hostedBy: 'E2E Club',
      venue: 'Hall A',
      startAt: iso(5),
      endAt: iso(6),
      registrationStart: iso(-1),
      registrationDeadline: iso(4),
      maxParticipants: 10,
      minTeamSize: 2,
      maxTeamSize: 3,
      paymentMode: 'at_registration',
      registrationFee: 20000,
      currency: 'INR',
    });
    const ev = admin.event(event.id);
    await ev.billing.purchase(['registration', 'scanning']);
    expect(
      (await ev.features())
        .filter((f) => f.enabled)
        .map((f) => f.feature)
        .sort(),
    ).toEqual(['registration', 'scanning']);
    const { key: clubKey } = await ev.apiKeys.create('Club site');
    const participantLink = await ev.inviteLinks.create({ role: 'participant', label: 'site' });
    const volunteerLink = await ev.inviteLinks.create({ role: 'volunteer', password: 'gate-pass' });
    await ev.setPaymentQr(new Blob([PNG], { type: 'image/png' }));
    expect((await ev.paymentQr()).url).toContain('X-Amz-Signature');

    // From here on: the club's own site, with its event key.
    const leader = await person(clubKey, event.id, 'Asha');
    const mate = await person(clubKey, event.id, 'Ravi');
    const preview = await leader.invites.preview(participantLink.token);
    expect(leader.invites.canUse(preview)).toBe(true);
    await leader.invites.startTeam(participantLink.token, {
      name: `Byte ${randomUUID().slice(0, 6)}`,
    });
    const team = await leader.event().myTeam.get();
    expect((await mate.teamLinks.preview(team.joinToken)).team.memberCount).toBe(1);
    await mate.teamLinks.join(team.joinToken);

    // Register with the receipt: uploaded straight to storage, then submitted.
    const missing = await leader
      .event()
      .myTeam.register()
      .catch((e) => e);
    expect(isEventKitError(missing, 'RECEIPT_REQUIRED')).toBe(true);
    const registered = await leader.event().myTeam.register({
      receipt: new Blob([PNG], { type: 'image/png' }),
    });
    expect(registered.payment.proofs[0]).toMatchObject({
      status: 'pending',
      amount: 40000,
      memberCount: 2,
    });

    // The organiser approves; both RSVP.
    const [proof] = await ev.payments.list('pending');
    await ev.payments.approve(proof!.id);
    expect((await leader.event().myRegistration.rsvp()).status).toBe('attending');

    // A volunteer joins through the staff link and checks people in.
    const volunteer = await person(clubKey, event.id, 'Vol');
    await volunteer.invites.joinAsStaff(volunteerLink.token, 'gate-pass');
    const gate = await ev.checkpoints.create({ name: 'Gate', type: 'entry' });
    const scanner = volunteer.createScanner({ checkpointId: gate.id, pingIntervalMs: 0 });
    const leaderQr = (await leader.event().myRegistration.get()).qrToken;
    const mateQr = (await mate.event().myRegistration.get()).qrToken;
    expect((await scanner.scan(leaderQr))!.result).toBe('accepted');
    const again = (await scanner.scan(leaderQr, { force: true }))!;
    expect(scanner.describe(again)).toMatch(/^Already scanned/);
    // Ravi never RSVPed: marked attending at the gate, then checked in.
    const refused = (await scanner.scan(mateQr))!;
    expect(refused.reason).toBe('not_attending');
    expect((await scanner.markAttendingAndScan(mateQr)).result).toBe('accepted');
    scanner.destroy();
    expect((await mate.event().myRegistration.get()).status).toBe('checked_in');

    // Polls.
    const poll = await volunteer.event().polls.create({
      question: 'Lunch?',
      options: ['Veg', 'Non-veg'],
      audience: ['participant'],
      defaultOptionIndex: 0,
    });
    await leader.event().polls.vote(poll.id, poll.options[1]!.id);
    expect((await leader.event().polls.get(poll.id)).myVote).toBe(poll.options[1]!.id);

    // Notifications.
    const channel = await ev.channels.create({
      name: 'All',
      audience: ['participant', 'volunteer', 'judge', 'admin'],
    });
    await volunteer
      .event()
      .channels.send(channel.id, { title: 'Lunch', body: 'Hall B', priority: 'urgent' });
    const feed: string[] = [];
    for await (const n of mate.event().notifications.all()) feed.push(n.title);
    expect(feed).toEqual(['Lunch']);

    // Judging.
    const judgeLink = await ev.inviteLinks.create({ role: 'judge', password: 'judge-pass' });
    const judge = await person(clubKey, event.id, 'Judge');
    await judge.invites.joinAsStaff(judgeLink.token, 'judge-pass');
    const idea = await ev.criteria.create({ name: 'Idea', description: '', maxScore: 10 });
    const [toJudge] = await judge.event().judging.teams();
    await judge.event().judging.saveScores(toJudge!.id, [{ criterionId: idea.id, value: 8 }]);
    const board = await ev.leaderboard();
    expect(board.entries[0]).toMatchObject({ total: 8, maxTotal: 10, judges: 1 });
    const hidden = await mate
      .event()
      .leaderboard()
      .catch((e) => e);
    expect(isEventKitError(hidden, 'LEADERBOARD_HIDDEN')).toBe(true);
  });

  it('refuses a wrong API key without signing anyone out', async () => {
    const ek = await person(platformKey);
    const wrong = createEventKit({ apiUrl, apiKey: 'ek_wrong' });
    const err = await wrong.auth.me().catch((e) => e);
    expect(isEventKitError(err, 'API_KEY_INVALID')).toBe(true);
    expect(ek.session.isSignedIn).toBe(true);
  });
});
