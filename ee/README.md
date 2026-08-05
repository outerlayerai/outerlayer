# OuterLayer Enterprise Edition (`ee/`)

Code under this directory — and under any directory named `ee/` in this
repository (currently `apps/tenant-dashboard/ee/`) — is **not** covered by the
repository's root license. It is governed by [`ee/LICENSE`](./LICENSE): source
is available to read, modify, and run for development and testing, but
production use requires a valid OuterLayer Enterprise license key.

## What is EE

The Enterprise feature set (matches the `EE_ENTITLEMENT_KEYS` registry in
`packages/ee-license`):

| Feature | Entitlement key | EE code location |
|---|---|---|
| Custom roles | `custom_roles` | `apps/tenant-dashboard/ee/features/custom-roles` |
| App-level roles | `app_level_roles` | `apps/tenant-dashboard/ee/features/app-access` |
| SAML SSO configuration | `custom_sso` | `apps/tenant-dashboard/ee/features/sso` |
| Audit-log viewer + CSV export | `audit_log` | `apps/tenant-dashboard/ee/features/audit-log` |

Deliberately **not** EE (stays under the root license):

- Audit-log **recording** (`src/services/audit-log/audit-log-service.ts`) —
  always on for every org, so the trail exists from day one and unlocking the
  viewer reveals history.
- The SSO **login/enforcement runtime** (domain check consulted by the login
  form) — password-login guarding is core auth and must work on unlicensed
  instances.
- Built-in default roles and all of `MembershipService` — basic multi-user
  self-hosting is not gated.
- The platform-admin (instance operator) surfaces.
- The license verifier itself (`packages/ee-license`) — it must run on
  unlicensed instances to deny.

## How gating works

- **Cloud**: features resolve through the tier matrix
  (`billing.tier_id` → `@repo/tier-config`).
- **Self-host** (`OUTERLAYER_SELF_HOSTED=true`): all product features are
  enabled and all numeric limits are unlimited. The EE entitlement keys above
  resolve to `false` unless `OUTERLAYER_EE_LICENSE_KEY` holds a valid license.
  Resolution surfaces: the dashboard's `EntitlementService` (feature checks +
  license resolution) and the gateway's `lib/entitlements.ts` +
  `SpanLimitService` (quotas, feature gates, span-ingest cap). The
  gateway resolves the generous-default half only; no EE key has a gateway
  write surface today, so it hard-codes `licensed: false` — wire
  `getSelfHostLicense` there if one ever lands.
- The license key is an Ed25519-signed token verified **offline** — no
  network call, no telemetry, air-gap friendly (see `packages/ee-license`).
  This is a hard design constraint: the self-host distribution promises zero
  phone-home.
- Expiry degrades gracefully: a 14-day grace window, then EE features
  deactivate. Data is never deleted and the instance never stops working.

## Import direction

Open code may import `ee/` modules (we hold copyright on both sides; the
repository ships as one artifact and gating happens at runtime — the
open-core model other platforms in this space use). Building with `ee/` deleted is not a supported configuration.
