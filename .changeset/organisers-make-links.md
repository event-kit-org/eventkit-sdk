---
'@eventkit/sdk': minor
---

Only organisers make new links (eventkit-core 0.20.1): `portal.me.resetLink()` and
`portal.me.team.reissueMemberLink()` are gone (the API refuses them with ASK_ORGANISERS).
`event.registrations.reissueLink(id, { emailLeader: true })` also emails the new link to the
team leader.
