---
'@eventkit/sdk': minor
---

Types follow eventkit-core 0.25.0. `event.setFeature()` and `event.billing.purchase()` are
deprecated: core refuses them (403 `FEATURES_MANAGED_BY_EVENTKIT`) because only the eventKit
platform admin switches an event's features now. Read them with `event.features()`. The
platform admin's `/v1/platform` routes are for eventkit-admin and aren't wrapped.
