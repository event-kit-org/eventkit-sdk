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
    // Console (clients)
    await ek.console.auth.signup({ email: 'a@b.co', name: 'A', password: 'password1' });
    await ek.console.auth.login({ email: 'a@b.co', password: 'password1' });
    await ek.console.auth.me();
    await ek.console.auth.changePassword('password1', 'password2');
    await ek.console.auth.forgotPassword('a@b.co');
    await ek.console.auth.resetPassword('tok', 'password3');
    await ek.console.auth.deleteAccount('password3');
    await ek.console.events.create({} as never);
    await ek.console.events.mine();
    await ek.push.config();
    await ek.raw.PUT('/v1/push/subscriptions', {
      body: { endpoint: 'https://p.test', keys: { p256dh: 'p', auth: 'a' } },
    });
    await ek.raw.DELETE('/v1/push/subscriptions', { body: { endpoint: 'https://p.test' } });

    // Portal
    const p = ek.portal;
    mock.on('POST /v1/portal/access', () => ({ session: { accessToken: 's' }, me: {} }));
    mock.on('POST /v1/portal/me/access/reset', () => ({
      link: {},
      session: { accessToken: 's2' },
    }));
    mock.on('POST /v1/portal/staff/signup', () =>
      json({ user: {}, role: 'volunteer', token: { accessToken: 't' } }, 201),
    );
    mock.on('POST /v1/portal/login', () => ({
      user: {},
      role: 'volunteer',
      token: { accessToken: 't' },
    }));
    mock.on('POST /v1/portal/uploads', () =>
      json(
        {
          key: 'k',
          url: 'https://bucket.test/k',
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
        },
        201,
      ),
    );
    mock.on('POST /v1/portal/me/uploads', () =>
      json(
        {
          key: 'k',
          url: 'https://bucket.test/k',
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
        },
        201,
      ),
    );
    await p.info();
    await p.previewLink('tok');
    await p.register({ linkToken: 'tok', team: { name: 'T' }, members: [], receipt: png() });
    await p.openSecretLink('ek_x');
    await p.me.get();
    await p.me.resetLink();
    await p.me.rsvp();
    await p.me.unrsvp();
    await p.me.cancel('a@b.co');
    await p.me.team.get();
    await p.me.team.payReceipt(png());
    await p.me.team.handOver(ID, 'a@b.co');
    await p.me.team.reissueMemberLink(ID);
    await p.me.polls.list();
    await p.me.polls.vote(ID, ID);
    await p.me.notifications.feed();
    await p.me.leaderboard();
    await p.me.submissions.list();
    await p.me.submissions.saveEntry(ID, {});
    await p.me.pushDevice.put({ endpoint: 'https://p.test', keys: { p256dh: 'p', auth: 'a' } });
    await p.me.pushDevice.remove('https://p.test');
    await p.staff.signup({
      linkToken: 't',
      linkPassword: 'p',
      name: 'V',
      email: 'v@x.co',
      password: 'password1',
    });
    await p.login('v@x.co', 'password1');

    // Event (owner and staff)
    await e.get();
    await e.update({});
    await e.features();
    await e.setFeature('scanning', true);
    await e.teams.delete(ID);
    await e.delete('Event');
    await e.emails.get('registration');
    await e.emails.save('registration', { subject: 's', html: '<p>h</p>' });
    await e.emails.reset('registration');
    await e.emails.preview('registration');
    await e.emails.sendTest('registration', { subject: 'Draft' });
    await e.paymentQr();
    await e.setPaymentQr(png());
    await e.paymentInstructionsFile();
    await e.setPaymentInstructionsFile(png());
    await e.removePaymentInstructionsFile();
    await e.billing.purchase(['registration']);
    await e.billing.usage();
    await e.apiKeys.create('site');
    await e.apiKeys.list();
    await e.apiKeys.revoke(ID);
    await e.createRegistrationLink();
    await e.inviteLinks.list();
    await e.inviteLinks.revoke(ID);
    await e.members.list();
    await e.members.add('a@b.co', 'reviewer');
    await e.members.changeRole(ID, 'judge');
    await e.members.remove(ID);
    await e.fields.list();
    await e.fields.create({} as never);
    await e.fields.update(ID, {});
    await e.fields.remove(ID);
    await e.teamRules.list();
    await e.teamRules.create({} as never);
    await e.teamRules.remove(ID);
    await e.teams.list();
    await e.teams.get(ID);
    await e.teams.shortlist(ID);
    await e.teams.confirm(ID);
    await e.registrations.cancel(ID);
    await e.registrations.restore(ID);
    await e.registrations.reissueLink(ID);
    await e.registrations.rotateQr(ID);
    await e.payments.list();
    await e.payments.attachReceipt(ID, png());
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
    await e.rounds.list();
    await e.rounds.create({} as never);
    await e.rounds.update(ID, {});
    await e.rounds.remove(ID);
    await e.rounds.duplicateCriteria(ID, ID);
    await e.submissions.list(ID);
    await e.submissions.create({} as never);
    await e.submissions.update(ID, {});
    await e.submissions.remove(ID);
    await e.submissions.duplicate(ID);
    await e.submissions.entries(ID);
    await e.submissions.fields.add(ID, {} as never);
    await e.submissions.fields.update(ID, ID, {});
    await e.submissions.fields.remove(ID, ID);

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
    expect(all.length - NOT_FOR_FRONT_ENDS.length).toBe(129);
  });
});
