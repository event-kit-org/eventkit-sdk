# @eventkit/sdk

Build your own front end on eventKit: accounts, teams, registration and UPI
payments, QR check-in, polls, notifications with web push, and judging. Every
API operation a front end can call is a typed function here.

```bash
npm install @eventkit/sdk
```

```ts
import { createEventKit, localStorageSession, isEventKitError } from '@eventkit/sdk';

const ek = createEventKit({
  apiUrl: 'https://api.your-eventkit.example',
  apiKey: 'ek_…', // your event's API key: identifies your app, grants nothing
  eventId: '…',
  session: localStorageSession(),
});

await ek.auth.signup({ email, name, password });
await ek.invites.startTeam(participantLinkToken, { name: 'Byte Club' });
await ek.event().myTeam.register({ receipt: file }); // uploaded straight to storage
const { qrToken } = await ek.event().myRegistration.get();
```

- Errors throw `EventKitError` with the API's `code`; `isEventKitError(e, 'TEAM_FULL')`.
- `ek.createScanner({ checkpointId })`: online-only scanning with device-made ids and safe retries.
- `@eventkit/sdk/react`: `<EventKitProvider>`, `useMyTeam()`, `useScanner()`, `useEventMutation()`, … (TanStack Query v5).
- `@eventkit/sdk/sw`: `registerPushHandlers(self, { urlFor })` for urgent notifications.
- Helpers: `formatIST`, `formatMoney`, `canRegister` (team rules are enforced by front ends), `linkFor`.

See `examples/vite-react` for a complete club site.

## Develop

`npm test` (unit, 90% gate), `npm run test:e2e` (against a running eventkit-core),
`npm run gen:api` (types from `../eventkit-core/openapi.json`), `npx changeset` to release.
