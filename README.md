# @eventkit/sdk

Build your event's own site (its **portal**) on eventKit: team registration
with UPI receipts, personal links with QR codes, RSVP, check-in scanning
(offline too), polls, notifications with web push, submissions, judging and
leaderboards. Every API operation is a typed function here, generated from
eventkit-core's OpenAPI spec.

## Install

The SDK isn't on the npm registry. Install it from GitHub:

```bash
npm install github:event-kit-org/eventkit-sdk
```

npm clones the repo and builds it (the `prepare` script), and your
`package.json` gets `"@eventkit/sdk": "github:event-kit-org/eventkit-sdk"`.
Imports stay `@eventkit/sdk`, `@eventkit/sdk/react` and `@eventkit/sdk/sw`.
Pin a commit for reproducible builds: `github:event-kit-org/eventkit-sdk#<commit>`.
npm 11 warns that the package's `prepare` script isn't in your `allowScripts`;
run `npm install-scripts approve @eventkit/sdk` once to record it.

Hosts that install without git, or skip build scripts, can use a tarball
instead: `npm pack` in a clone, commit the `.tgz` to your repo, and
`npm install ./vendor/eventkit-sdk-<version>.tgz` (how `mach-one-web` does it).

## Who uses what

| Who                   | Where                                            | How they identify                                                                                                    |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The organiser (owner) | the eventKit console, and their own portal       | an eventKit account                                                                                                  |
| Co-admins, reviewers  | the eventKit console (co-admins also the portal) | an eventKit account the owner added by email (`event.members.add`)                                                   |
| Volunteers, judges    | the portal                                       | a portal account for that event, made through a password-protected staff link                                        |
| Participants          | the portal                                       | **no account**: the team leader registers everyone; each member gets a participant ID, a QR code and a personal link |

## Set up

```ts
import { createEventKit, localStorageSession, isEventKitError } from '@eventkit/sdk';

const ek = createEventKit({
  apiUrl: 'https://api.your-eventkit.example',
  apiKey: 'ek_…', // the event's API key: identifies the portal, grants nothing
  eventId: '…',
  session: localStorageSession(),
});

const info = await ek.portal.info(); // event, form fields, team rules, paths, places, payment details
```

`apiUrl` may list several addresses, primary first, separated by commas
(`'https://api.example,https://api-backup.example'`). Requests go to the first
that answers. When it can't be reached, reads move to the next at once, and
writes move only after its `/health` also fails, so nothing is sent twice.
While an address is marked down (shared across tabs through `localStorage`),
each request first checks its `/health` (uncached; one check reused for 5 s)
and goes back to it as soon as it answers. `createFailoverFetch` gives the same
behaviour to apps with their own HTTP client.

## Participants

```ts
// /register/{token}: the leader registers the whole team. With payment at
// registration, pass the receipt (JPG/PNG/WebP, ≤ 5 MB): it is uploaded first.
const { team, members } = await ek.portal.register({
  linkToken,
  team: { name: 'Byte Club', answers: { [projectFieldId]: 'Smart bins' } },
  members: [
    { name: 'Asha', email: 'asha@…', answers: { [phoneFieldId]: '+91 …' } },
    { name: 'Ravi', email: 'ravi@…' },
  ],
  receipt: file,
});
// Every member has participantCode and qrToken. Only the leader's entry has
// `link` (shown once); when mailing is on the leader is emailed everyone's links.

// /me/{token}: swaps the token for a session and strips it from the address bar.
const me = await ek.portal.openSecretLink(undefined, { paths: info.paths });
await ek.portal.me.rsvp(); // confirmed → attending (unless the event has RSVP off)
await ek.portal.me.team.get();
await ek.portal.me.team.payReceipt(file); // leader: after shortlisting or a rejection
await ek.portal.me.team.addMember({ name: 'Meera', email: 'meera@…' }); // leader, until registration closes
await ek.portal.me.cancel('asha@…'); // confirmed with the registered email or a phone answer
```

Personal links (`/me/ek_…`) last until 7 days after the event. **Only
organisers issue new links**: `event.registrations.reissueLink(id, { emailLeader: true })`
replaces one (old link and its sessions stop working), and
`event.registrations.sendLink(id, 'member' | 'leader')` emails the current one
again unchanged. Participants and leaders can't replace links themselves
(`ASK_ORGANISERS`).

Once the team is confirmed (`me.confirmed`), participants also get polls,
notifications and push; from the event day (`activitiesOpen`), submissions and
leaderboards:

```ts
await ek.portal.me.polls.vote(pollId, optionId); // or a value for text/number/rating polls
await ek.portal.me.polls.answerGroup(groupId, answers); // a question set, all or nothing
const feed = await ek.portal.me.notifications.feed(); // newest first; page with { before }
await ek.portal.me.push.enable(); // urgent notifications on this device
await ek.portal.me.submissions.sendResponse(submissionId, answers);
await ek.portal.me.leaderboards.list();
```

Before confirmation these give `NOT_CONFIRMED`; submissions and leaderboards
before the event day give `NOT_EVENT_DAY`.

## Volunteers and judges

```ts
await ek.portal.staff.signup({ linkToken, linkPassword, name, email, password });
await ek.portal.login(email, password); // staff, the owner and co-admins

const scanner = ek.createScanner({ checkpointId });
const result = await scanner.scan(code); // a QR token or a typed participant ID
scanner.online; // false while offline: scans are decided on the device and queued
scanner.pendingCount; // queued scans, sent with scans.batch once back online
scanner.log; // pending | synced | conflict

const ev = ek.event();
await ev.judging.saveScores(teamId, [{ criterionId, value: 8 }], 'Strong demo', roundId);
```

Each scan gets a UUID on the device and is retried with the same id, so it can
never count twice. Offline scanning is on by default (IndexedDB): the
checkpoint's roster is cached while online, and the server's result is the
record when the queue syncs. At a gate, scanning someone inside asks for an
exit reason (`leavingFrom(error)` reads it from `EXIT_REASON_REQUIRED`), then
`scanner.scan(code, { exitReason })`.

## The organiser

```ts
const ek = createEventKit({ apiUrl, apiKey: PLATFORM_KEY, session });
await ek.console.auth.signup({ email, name, password });
const { event } = await ek.console.events.create({ … });
const ev = ek.event(event.id);
await ev.setPortal({ url: 'https://machzero.vercel.app', paths: { me: '/p/{token}' } });
const { key } = await ev.apiKeys.create('Portal');
const reg = await ev.createRegistrationLink(); // reg.url: https://machzero.vercel.app/register/…
const gate = await ev.createStaffLink({ role: 'volunteer', password: 'gate-pass' });
await ev.features(); // read only: the eventKit platform admin switches features on
```

`ek.event()` covers teams, registrations, payments, checkpoints, scans,
attendance, polls, channels, notifications, rounds, criteria, judging,
submissions, fields, team rules, tracks, leaderboards, assignments, insights,
emails, members, API keys and invite links, for the organiser and (where their
role allows) staff.

`ev.setFeature()` and `ev.billing.purchase()` are deprecated: since
eventkit-core 0.25.0 they answer `403 FEATURES_MANAGED_BY_EVENTKIT`.

## Your own registration email

When a team registers, eventKit emails the **leader** every member's
participant ID and dashboard link, for the leader to pass on. The organiser
can replace that email with their own HTML: any layout and styles, filled in
and escaped by eventKit when it sends. Mail apps run no scripts, so buttons are
links; the helpers put the right link in each one.

```ts
import { registrationEmail as t } from '@eventkit/sdk';

const html = `<!doctype html><html><body style="background:#1a1b2f;color:#ebe5f6">
  <h1>${t.team.name} is registered for ${t.event.name}</h1>
  ${t.eachMember(
    (m) => `
    <p>${m.name}${t.when(m.isLeader, ' (leader)')} · ${m.participantCode}</p>
    ${t.when(m.dashboardUrl, t.button({ href: m.dashboardUrl, label: 'Open dashboard', background: '#a78bfa' }))}
`,
  )}
  ${t.when(t.links.portal, `<a href="${t.links.portal}">Event site</a>`)}
</body></html>`;

const ev = ek.event(eventId); // signed in as an admin of the event
const draft = { subject: `${t.event.name}: ${t.team.name} is registered`, html };
await ev.emails.preview('registration', draft); // filled with a made-up team
await ev.emails.sendTest('registration', draft); // to your own inbox
await ev.emails.save('registration', draft); // INVALID_TEMPLATE lists any mistakes
await ev.emails.reset('registration'); // back to eventKit's default
```

`ev.emails.get('registration')` returns the current template and every variable
it can use. You can also write the Mustache yourself (`{{team.name}}`,
`{{#members}}…{{linkUrl}}…{{/members}}`); `{{{raw}}}` is refused. Show
`linkUrl` inside the member list, or leaders won't have their teammates' links.
The email holds no QR codes: each member's QR appears on their dashboard once
the team is confirmed.

## Accounts

`ek.console.auth.changePassword(current, next)` (and `ek.portal.changePassword`
for staff) ends every other session and keeps this one signed in.
`forgotPassword(email)` emails a reset link to the console;
`resetPassword(token, next)` sets the new password from it and signs in.
`deleteAccount(password)` deletes an eventKit account (refused with
`OWNS_EVENTS` while it owns events) and signs out.

## Also

- Errors throw `EventKitError` with the API's `code`: `isEventKitError(e, 'TEAM_SIZE')`;
  `fieldErrors(e)` maps validation errors to form fields. A 401 clears the session;
  `403 WRONG_SESSION` doesn't.
- `session.who` (`decodeSession(token)`): whether the session is a participant, staff or client one.
- `parseLink(url, paths)` tells registration, staff and personal links apart; `portalUrl(base, path, token)` builds one.
- `@eventkit/sdk/react`: `<EventKitProvider>`, `usePortalInfo()`, `useSecretLink()`, `useMe()`,
  `useMyTeam()`, `useMyPolls()`, `useMySubmissions()`, `useMyLeaderboard()`, `useMyLeaderboards()`,
  `useMyNotifications()`, `usePortalMutation()`, `useScanner()`, `useScanLog()`, `useOutside()`,
  `useOnlineStatus()`, and the event hooks (`useEvent()`, `useRounds()`, `useJudgingTeams()`,
  `useEventMutation()`, …). TanStack Query v5.
- `@eventkit/sdk/sw`: `registerPushHandlers(self, { urlFor })` for urgent notifications;
  participants enable push with `ek.portal.me.push.enable()`, staff with `ek.push.enable()`.
- Helpers: `checkRegistration` (team size, answers and team rules before sending; the API checks
  again), `formatIST`, `formatMoney`, `amountDue`, `teamDisplayStatus`, `toWebp`.
- `ek.raw` is the typed HTTP client underneath, for anything not wrapped yet.

See `examples/vite-react` for a complete portal, and `eventkit-portal` for the
full template portal built only on this SDK.

## Develop

`npm install` also builds `dist/` (`prepare`). `npm test` (unit, 90% gate), `npm run test:e2e` (against a running eventkit-core:
`EVENTKIT_API_URL`, `EVENTKIT_PLATFORM_KEY`), `npm run gen:api` (types from
`../eventkit-core/openapi.json`), `npx changeset` to release.
