---
'@eventkit-sdk/client': minor
---

More organisers per event: `event.members.add(email, 'admin' | 'reviewer')`
(owner only), `members.changeRole` takes `admin` and `reviewer`, and
`members.remove` also lets someone leave. Events carry `isOwner`; teams carry
`shortlistedBy` and `confirmedBy`. Needs eventkit-core 0.8.0.
