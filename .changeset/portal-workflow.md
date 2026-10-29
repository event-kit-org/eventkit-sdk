---
'@eventkit-sdk/client': minor
---

Account-free participants and event portals (needs eventkit-core 0.3.0). New `ek.portal` (info, register a whole team with its receipt, personal secret links, `me.*`, staff signup and portal login) and `ek.console` (client auth and events); `event.setPortal`, `createRegistrationLink`, `createStaffLink`, `registrations.reissueLink` / `rotateQr`, `payments.attachReceipt`; `decodeSession()`, `session.who` and `useSession().who` tell participant, staff and client sessions apart. Removed: participant accounts, team forming and invites (`invites`, `teamInvites`, `teamLinks`, `event.myTeam`, `event.myRegistration`), `canRegister` (now `checkRegistration`). React: portal hooks replace `useMyRegistration` and `useTeamInvites`.
