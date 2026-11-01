---
'@eventkit/sdk': minor
---

Offline scanning, exit checkpoints and staged release (core 0.16.0).

- `createScanner` keeps scanning offline: it caches the checkpoint's roster (`scans.roster`), decides scans on the device, queues them and sends them with `scans.batch` when back online. New: `offlineReady`, `pendingCount`, `log`, `onChange`, `sync`, `refreshRoster`. Pass `offline: false` for online-only.
- `pauseMs` (default 1200): after any camera result, other codes are ignored for a moment.
- Gate checkpoints (in and out after check-in): someone going out needs `scan(code, { exitReason })`; without it the scan throws EXIT_REASON_REQUIRED and `leavingFrom(e)` says who, so the volunteer can pick a reason and scan again.
- `scans.list` (scan log), `scans.outside`, `teams.release`; React `useScanLog`, `useOutside`, and more state from `useScanner`.
