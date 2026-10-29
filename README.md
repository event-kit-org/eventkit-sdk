# @eventkit-sdk/client

Build your event's own site (its **portal**) on eventKit: team registration
with UPI receipts, personal links with QR codes, RSVP, check-in scanning,
polls, notifications with web push, and judging. Every API operation is a
typed function here.

```bash
npm install @eventkit-sdk/client
```

## Who uses what

| Who                    | Where                                            | How they identify                                                                                                    |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The organiser (client) | the eventKit console, and their own portal       | an eventKit account                                                                                                  |
| Co-admins, reviewers   | the eventKit console (co-admins also the portal) | an eventKit account the owner added by email (`event.members.add`)                                                   |
| Volunteers, judges     | the portal                                       | a portal account for that event, made through a password-protected staff link                                        |
| Participants           | the portal                                       | **no account**: the team leader registers everyone; each member gets a participant ID, a QR code and a personal link |

## The portal

```ts
import { createEventKit, localStorageSession, isEventKitError } from '@eventkit-sdk/client';

const ek = createEventKit({
  apiUrl: 'https://api.your-eventkit.example',
  apiKey: 'ek_…', // the event's API key: identifies the portal, grants nothing
  eventId: '…',
  session: localStorageSession(),
});

const info = await ek.portal.info(); // event, form fields, team rules, paths, payment QR

// /register/{token}: the leader registers the whole team (receipt uploaded first).
const { members } = await ek.portal.register({
  linkToken,
  team: { name: 'Byte Club' },
  members: [
    { name: 'Asha', email: 'asha@…', phone: '+91 …' },
    { name: 'Ravi', email: 'ravi@…', phone: '+91 …' },
  ],
  receipt: file,
});
// members[i]: participantCode, qrToken, link.url — shown once, save and share them.

// /me/{token}: swaps the token for a session and strips it from the address bar.
const me = await ek.portal.openSecretLink(undefined, { paths: info.paths });
await ek.portal.me.rsvp();
await ek.portal.me.resetLink(); // the link leaked: old link and sessions stop working

// Staff: sign up through a staff link, or sign in (the owner too).
await ek.portal.staff.signup({ linkToken, linkPassword, name, email, password });
await ek.portal.login(email, password);
const scanner = ek.createScanner({ checkpointId }); // QR codes or typed participant IDs
```

Personal links (`/me/ek_…`) last until 7 days after the event. A leaked link
can be replaced by its owner (`me.resetLink()`), the team leader
(`me.team.reissueMemberLink(id)`) or the organiser
(`event.registrations.reissueLink(id)`). Cancelling and handing over the team
also need the registered email or phone.

## The console

```ts
const ek = createEventKit({ apiUrl, apiKey: PLATFORM_KEY, session });
await ek.console.auth.signup({ email, name, password });
const { event } = await ek.console.events.create({ … });
const ev = ek.event(event.id);
await ev.setPortal({ url: 'https://machzero.vercel.app', paths: { me: '/p/{token}' } });
await ev.billing.purchase(['registration', 'scanning']);
const { key } = await ev.apiKeys.create('Portal');
const reg = await ev.createRegistrationLink(); // reg.url: https://machzero.vercel.app/register/…
const gate = await ev.createStaffLink({ role: 'volunteer', password: 'gate-pass' });
```

`ek.event()` also has teams, registrations, payments, checkpoints, attendance,
polls, channels, criteria, judging, fields and team rules, for the organiser
and (where their role allows) staff.

## Your own registration email

When a team registers, eventKit emails the leader every member's participant ID
and dashboard link. The organiser can replace that email with their own HTML:
any layout and styles, filled in and escaped by eventKit when it sends.
Mail apps run no scripts, so buttons are links; the helpers put the right link
in each one.

```ts
import { registrationEmail as t } from '@eventkit-sdk/client';

const html = `<!doctype html><html><body style="background:#1a1b2f;color:#ebe5f6">
  <h1>${t.team.name} is registered for ${t.event.name}</h1>
  ${t.eachMember(
    (m) => `
    <p>${m.name}${t.when(m.isLeader, ' (leader)')} · ${m.participantCode}</p>
    ${t.when(m.dashboardUrl, t.button({ href: m.dashboardUrl, label: 'Open dashboard', background: '#a78bfa' }))}`,
  )}
  ${t.when(t.links.portal, `<a href="${t.links.portal}">Event site</a>`)}
</body></html>`;

const ev = ek.event(eventId); // signed in as the event's owner
const draft = { subject: `${t.event.name}: ${t.team.name} is registered`, html };
await ev.emails.preview('registration', draft); // filled with a made-up team
await ev.emails.sendTest('registration', draft); // to the owner's inbox
await ev.emails.save('registration', draft); // INVALID_TEMPLATE lists any mistakes
await ev.emails.reset('registration'); // back to eventKit's default
```

`ev.emails.get('registration')` returns the current template and every variable
it can use. You can also write the Mustache yourself (`{{team.name}}`,
`{{#members}}…{{/members}}`); `{{{raw}}}` is refused. The email holds no QR
codes: each member's QR appears on their dashboard once the team is confirmed.

## Accounts

`ek.console.auth.changePassword(current, next)` (and `ek.portal.changePassword` for staff)
ends every other session and keeps this one signed in. `forgotPassword(email)` emails a
reset link to the console; `resetPassword(token, next)` sets the new password from it
and signs in. `deleteAccount(password)` deletes an eventKit account (refused with
`OWNS_EVENTS` while it owns events) and signs out.

## Also

- Errors throw `EventKitError` with the API's `code`: `isEventKitError(e, 'LINK_NOT_FOUND')`.
- `session.who` (`decodeSession(token)`): whether the session is a participant, staff or client one.
- `parseLink(url, paths)` tells registration, staff and personal links apart; `portalUrl(base, path, token)` builds one.
- `@eventkit-sdk/client/react`: `<EventKitProvider>`, `usePortalInfo()`, `useSecretLink()`, `useMe()`,
  `useMyTeam()`, `useMyPolls()`, `useMyNotifications()`, `usePortalMutation()`, `useScanner()`,
  and the event hooks (`useEvent()`, `useEventMutation()`, …). TanStack Query v5.
- `@eventkit-sdk/client/sw`: `registerPushHandlers(self, { urlFor })` for urgent notifications;
  participants enable push with `ek.portal.me.push.enable()`, staff with `ek.push.enable()`.
- Helpers: `checkRegistration` (team size, details and team rules before sending; the API checks
  again), `formatIST`, `formatMoney`, `teamDisplayStatus`.

See `examples/vite-react` for a complete portal.

## Develop

`npm test` (unit, 90% gate), `npm run test:e2e` (against a running eventkit-core),
`npm run gen:api` (types from `../eventkit-core/openapi.json`), `npx changeset` to release.
