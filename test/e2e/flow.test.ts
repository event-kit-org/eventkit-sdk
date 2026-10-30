/**
 * The whole event, through the devkit only, against a running eventkit-core:
 *   EVENTKIT_API_URL=http://localhost:4000 EVENTKIT_PLATFORM_KEY=... npm run test:e2e
 * Every account is fresh; run it against a development database.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEventKit,
  type EventKit,
  isEventKitError,
  memorySession,
  parseLink,
} from '../../src';

const apiUrl = process.env.EVENTKIT_API_URL ?? 'http://127.0.0.1:47400';
const platformKey = process.env.EVENTKIT_PLATFORM_KEY ?? 'e2e-platform-key-e2e-platform-key-00';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PORTAL = 'https://machzero.example';

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const png = () => new Blob([PNG], { type: 'image/png' });
const fails = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

/** A browser on the club's portal: its own session, the event's key. */
const portal = (apiKey: string, eventId: string): EventKit =>
  createEventKit({ apiUrl, apiKey, eventId, session: memorySession() });

describe('an event, end to end through the devkit', () => {
  it('console → portal registration → secret links → check-in → polls → notifications → judging', async () => {
    // The client: an eventKit account in the console (platform key).
    const owner = { email: `${randomUUID()}@e2e.test`, password: 'password123' };
    const console_ = createEventKit({ apiUrl, apiKey: platformKey, session: memorySession() });
    expect((await console_.ready()).status).toBe('ok');
    await console_.console.auth.signup({ ...owner, name: 'Organiser' });
    const { event } = await console_.console.events.create({
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
    const ev = console_.event(event.id);
    await ev.setPortal({ url: PORTAL, paths: { me: '/p/{token}' } });
    await ev.billing.purchase(['registration', 'scanning']);
    const { key: clubKey } = await ev.apiKeys.create('Club site');
    const regLink = await ev.createRegistrationLink({ label: 'site' });
    expect(regLink.url).toBe(`${PORTAL}/register/${regLink.token}`);
    const gateLink = await ev.createStaffLink({ role: 'volunteer', password: 'gate-pass' });
    expect(parseLink(gateLink.url!)).toEqual({ kind: 'staff', token: gateLink.token });
    await ev.setPaymentQr(png());

    // The portal, with the event's key. The leader registers the whole team.
    const site = portal(clubKey, event.id);
    const info = await site.portal.info();
    expect(info).toMatchObject({ registrationOpen: true, paths: { me: '/p/{token}' } });
    expect((await site.portal.previewLink(regLink.token)).kind).toBe('registration');
    const team = {
      linkToken: regLink.token,
      team: { name: `Byte ${randomUUID().slice(0, 6)}` },
      members: [
        { name: 'Asha', email: `${randomUUID()}@e2e.test` },
        { name: 'Ravi', email: `${randomUUID()}@e2e.test` },
      ],
    };
    expect(isEventKitError(await fails(site.portal.register(team)), 'RECEIPT_REQUIRED')).toBe(true);
    const registered = await site.portal.register({ ...team, receipt: png() });
    expect(registered.payment.proof).toMatchObject({ status: 'pending', amount: 40000 });
    const [asha, ravi] = registered.members as [
      (typeof registered.members)[0],
      (typeof registered.members)[0],
    ];
    expect(asha.participantCode).toMatch(/^[A-Z0-9]+-\d{4}$/);
    expect(asha.link!.url).toBe(`${PORTAL}/p/${asha.link!.token}`);

    // Each opens their personal link on their own phone.
    const leader = portal(clubKey, event.id);
    const mate = portal(clubKey, event.id);
    const replaced: string[] = [];
    const fakeHistory = {
      state: null,
      replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
    } as unknown as History;
    const paths = info.paths;
    const at = (path: string) => ({ pathname: path }) as Location;
    expect(
      (
        await leader.portal.openSecretLink(undefined, {
          paths,
          location: at(`/p/${asha.link!.token}`),
          history: fakeHistory,
        })
      ).isLeader,
    ).toBe(true);
    expect(replaced).toEqual(['/p']);
    await mate.portal.openSecretLink(ravi.link!.token);

    // The client approves the receipt; Asha RSVPs.
    const [proof] = await ev.payments.list('pending');
    await ev.payments.approve(proof!.id);
    expect((await leader.portal.me.rsvp()).status).toBe('attending');
    expect((await leader.portal.me.team.get()).members).toHaveLength(2);

    // Cancelling asks for the registered email.
    expect(
      isEventKitError(
        await fails(mate.portal.me.cancel('wrong@e2e.test')),
        'CONFIRMATION_MISMATCH',
      ),
    ).toBe(true);

    // A volunteer creates a portal account through the staff link and checks people in.
    const volunteer = portal(clubKey, event.id);
    await volunteer.portal.staff.signup({
      linkToken: gateLink.token,
      linkPassword: 'gate-pass',
      name: 'Vol',
      email: `${randomUUID()}@e2e.test`,
      password: 'password123',
    });
    const gate = await ev.checkpoints.create({ name: 'Gate', type: 'entry' });
    const scanner = volunteer.createScanner({ checkpointId: gate.id, pingIntervalMs: 0 });
    expect((await scanner.scan(asha.qrToken))!.result).toBe('accepted');
    const again = (await scanner.scan(asha.qrToken, { force: true }))!;
    expect(scanner.describe(again)).toMatch(/^Already scanned/);
    // Ravi never RSVPed: his participant ID is typed, he is marked attending, then checked in.
    const refused = (await scanner.scan(ravi.participantCode))!;
    expect(refused.reason).toBe('not_attending');
    const checked = await scanner.markAttendingAndScan(ravi.participantCode);
    expect(checked).toMatchObject({
      result: 'accepted',
      participant: { participantCode: ravi.participantCode },
    });
    scanner.destroy();
    expect((await mate.portal.me.get()).status).toBe('checked_in');

    // A leaked link: Ravi resets it; the old link and its sessions stop working.
    const otherPhone = portal(clubKey, event.id);
    await otherPhone.portal.openSecretLink(ravi.link!.token);
    const fresh = await mate.portal.me.resetLink();
    expect(fresh.token).not.toBe(ravi.link!.token);
    expect(await fails(otherPhone.portal.me.get())).toMatchObject({ status: 401 });
    expect(
      await fails(portal(clubKey, event.id).portal.openSecretLink(ravi.link!.token)),
    ).toMatchObject({ code: 'LINK_NOT_FOUND' });
    expect((await mate.portal.me.get()).name).toBe('Ravi');

    // Polls.
    const poll = await volunteer.event().polls.create({
      question: 'Lunch?',
      options: ['Veg', 'Non-veg'],
      audience: ['participant'],
      defaultOptionIndex: 0,
    });
    await leader.portal.me.polls.vote(poll.id, poll.options[1]!.id);
    const [mine] = await leader.portal.me.polls.list();
    expect(mine!.myVote).toBe(poll.options[1]!.id);

    // Notifications.
    const channel = await ev.channels.create({
      name: 'All',
      audience: ['participant', 'volunteer', 'judge', 'admin'],
    });
    await volunteer
      .event()
      .channels.send(channel.id, { title: 'Lunch', body: 'Hall B', priority: 'urgent' });
    const feed: string[] = [];
    for await (const n of mate.portal.me.notifications.all()) feed.push(n.title);
    expect(feed).toEqual(['Lunch']);

    // The owner signs in on the portal with their eventKit login.
    const ownerOnPortal = portal(clubKey, event.id);
    await ownerOnPortal.portal.login(owner.email, owner.password);
    expect((await ownerOnPortal.event().get()).role).toBe('admin');

    // Judging.
    const judgeLink = await ev.createStaffLink({ role: 'judge', password: 'judge-pass' });
    const judge = portal(clubKey, event.id);
    await judge.portal.staff.signup({
      linkToken: judgeLink.token,
      linkPassword: 'judge-pass',
      name: 'Judge',
      email: `${randomUUID()}@e2e.test`,
      password: 'password123',
    });
    const round = await ev.rounds.create({ name: 'Final' } as never);
    const idea = await ev.criteria.create({
      roundId: round.id,
      name: 'Idea',
      description: '',
      maxScore: 10,
    });
    const [toJudge] = await judge.event().judging.teams();
    await judge.event().judging.saveScores(toJudge!.id, [{ criterionId: idea.id, value: 8 }]);
    const board = await ev.leaderboard();
    expect(board.entries[0]).toMatchObject({ total: 8, maxTotal: 10, judges: 1 });
    expect(isEventKitError(await fails(mate.portal.me.leaderboard()), 'LEADERBOARD_HIDDEN')).toBe(
      true,
    );
  });

  it('refuses a wrong API key without signing anyone out', async () => {
    const ek = createEventKit({ apiUrl, apiKey: platformKey, session: memorySession() });
    await ek.console.auth.signup({
      email: `${randomUUID()}@e2e.test`,
      name: 'X',
      password: 'password123',
    });
    const wrong = createEventKit({
      apiUrl,
      apiKey: 'ek_wrong',
      session: memorySession(ek.session.token),
    });
    expect(isEventKitError(await fails(wrong.console.auth.me()), 'API_KEY_INVALID')).toBe(true);
    expect(ek.session.isSignedIn).toBe(true);
  });
});
