---
'@eventkit/sdk': minor
---

Changing a team after registering (eventkit-core 0.21.0): `event.registrations.update(id,
{ name, email, resendToLeader })`, `event.teams.addMember(teamId, member)` and
`portal.me.team.addMember(member)`. Payment proofs carry `registrationIds`, and team payment
lists `unpaid` members.
