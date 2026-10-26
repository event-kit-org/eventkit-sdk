import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { client, json, png } from './mock';

const spec = JSON.parse(
  readFileSync(new URL('../../eventkit-core/openapi.json', import.meta.url), 'utf8'),
) as {
  paths: Record<string, Record<string, unknown>>;
};
/** Server-to-server only: payment providers call it, never a front end. */
const NOT_FOR_FRONT_ENDS = ['POST /v1/billing/webhooks/{provider}'];

const ID = '33333333-3333-4333-8333-333333333333';

describe('every API operation is reachable through the devkit', () => {
  it('calls each one once', async () => {
    const { ek, mock, event: e } = client();
    mock.on('POST /v1/auth/*', () => ({ user: {}, token: { accessToken: 't' } }));
    mock.on('POST /v1/events/:id/uploads', () =>
      json(
        {
          key: 'k',
          url: 'https://bucket.test/k',
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          expiresIn: 300,
        },
        201,
      ),
    );
    mock.on('PUT /k', () => new Response(null));
    mock.on('GET /v1/events/:id/notifications', () => []);

    await ek.health();
    await ek.ready();
    await ek.auth.signup({ email: 'a@b.co', name: 'A', password: 'password1' });
    await ek.auth.login({ email: 'a@b.co', password: 'password1' });
    await ek.auth.me();
    await ek.events.create({} as never);
    await ek.events.mine();
    await ek.invites.preview('tok');
    await ek.invites.joinAsStaff('tok', 'pw');
    await ek.invites.startTeam('tok', { name: 'T' });
    await ek.teamInvites.list();
    await ek.teamInvites.accept(ID);
    await ek.teamInvites.decline(ID);
    await ek.teamLinks.preview('tok');
    await ek.teamLinks.join('tok');
    await ek.push.config();
    // push subscribe/unsubscribe need a browser; the raw calls are the same routes.
    await ek.raw.PUT('/v1/push/subscriptions', {
      body: { endpoint: 'https://p.test', keys: { p256dh: 'p', auth: 'a' } },
    });
    await ek.raw.DELETE('/v1/push/subscriptions', { body: { endpoint: 'https://p.test' } });

    await e.get();
    await e.update({});
    await e.features();
    await e.setFeature('scanning', true);
    await e.paymentQr();
    await e.setPaymentQr(png());
    await e.billing.purchase(['registration']);
    await e.billing.usage();
    await e.apiKeys.create('site');
    await e.apiKeys.list();
    await e.apiKeys.revoke(ID);
    await e.inviteLinks.create({ role: 'participant' });
    await e.inviteLinks.list();
    await e.inviteLinks.revoke(ID);
    await e.members.list();
    await e.members.changeRole(ID, 'judge');
    await e.members.remove(ID);
    await e.fields.list();
    await e.fields.create({} as never);
    await e.fields.update(ID, {});
    await e.fields.remove(ID);
    await e.teamRules.list();
    await e.teamRules.create({} as never);
    await e.teamRules.remove(ID);
    await e.myTeam.get();
    await e.myTeam.update({ name: 'T' });
    await e.myTeam.invite('x@y.co');
    await e.myTeam.withdrawInvite(ID);
    await e.myTeam.updateMember(ID, {});
    await e.myTeam.removeMember(ID);
    await e.myTeam.leave();
    await e.myTeam.disband();
    await e.myTeam.handOver(ID);
    await e.myTeam.resetJoinLink();
    await e.myTeam.register();
    await e.myTeam.payReceipt(png());
    await e.myRegistration.get();
    await e.myRegistration.rsvp();
    await e.myRegistration.unrsvp();
    await e.myRegistration.cancel();
    await e.teams.list();
    await e.teams.get(ID);
    await e.teams.shortlist(ID);
    await e.teams.confirm(ID);
    await e.registrations.cancel(ID);
    await e.registrations.restore(ID);
    await e.payments.list();
    await e.payments.approve(ID);
    await e.payments.reject(ID, 'blurry');
    await e.checkpoints.list();
    await e.checkpoints.create({} as never);
    await e.checkpoints.update(ID, {});
    await e.checkpoints.remove(ID);
    await e.scan({ id: ID, checkpointId: ID, qrToken: 'q' });
    await e.attendance.mark('q');
    await e.polls.list();
    await e.polls.get(ID);
    await e.polls.create({} as never);
    await e.polls.update(ID, {});
    await e.polls.remove(ID);
    await e.polls.addOption(ID, 'x');
    await e.polls.renameOption(ID, ID, 'y');
    await e.polls.removeOption(ID, ID);
    await e.polls.vote(ID, ID);
    await e.channels.list();
    await e.channels.create({ name: 'c', audience: ['admin'] });
    await e.channels.update(ID, { name: 'd' });
    await e.channels.remove(ID);
    await e.channels.send(ID, { title: 't', body: 'b' });
    await e.notifications.feed();
    await e.criteria.list();
    await e.criteria.create({} as never);
    await e.criteria.update(ID, {});
    await e.criteria.remove(ID);
    await e.judging.teams();
    await e.judging.saveScores(ID, []);
    await e.leaderboard();

    const toTemplate = (method: string, path: string) =>
      Object.keys(spec.paths).find((p) => {
        const re = new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`);
        return re.test(path) && method.toLowerCase() in spec.paths[p]!;
      });
    const reached = new Set(
      mock.calls
        .filter((c) => c.url.startsWith('https://api.test'))
        .map((c) => `${c.method} ${toTemplate(c.method, c.path) ?? c.path}`),
    );
    const all = Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`),
    );
    const missing = all.filter((op) => !reached.has(op) && !NOT_FOR_FRONT_ENDS.includes(op));
    expect(missing).toEqual([]);
    expect(all.length - NOT_FOR_FRONT_ENDS.length).toBe(96);
  });
});
