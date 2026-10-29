---
'@eventkit-sdk/client': minor
---

Account settings: `console.auth.changePassword`, `forgotPassword`,
`resetPassword` and `deleteAccount`, and `portal.changePassword` for staff.
Changing or resetting keeps this device signed in with the fresh token;
deleting signs out. Needs eventkit-core 0.9.0.
