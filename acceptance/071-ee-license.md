# EE License — Acceptance Criteria

Self-host license validation: what a self-hosted instance is entitled to
with and without a valid enterprise license key, and how the license
mechanism interacts with billing tiers and Cloud deployments.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Self-host entitlement resolution

1. `AC-071-01` **Given** a self-hosted instance with no valid enterprise license, **When** entitlements are resolved, **Then** every EE-gated capability (custom roles, per-app roles, SSO, audit log) is disabled while every other product feature stays enabled.
2. `AC-071-02` **Given** a self-hosted instance, **When** a numeric usage quota is resolved, **Then** it is always unlimited — usage metering is a Cloud concept, not a self-host one, license or no license.
3. `AC-071-03` **Given** a self-hosted instance with a valid enterprise license, **When** entitlements are resolved, **Then** every EE-gated capability is enabled.
4. `AC-071-04` **Given** an unlicensed self-hosted instance, **When** its billing tier data is changed to a tier that would unlock an EE capability on Cloud, **Then** the EE capability stays locked — only a valid license key unlocks it on self-host.

## Signature verification

5. `AC-071-05` **Given** a license key whose payload was altered after signing or that was signed by a different key, **When** it is verified, **Then** it is rejected and the deployment is treated as unlicensed.

## Grace period and expiry

6. `AC-071-06` **Given** a license past its expiry date but within the 14-day grace window, **When** entitlements are resolved, **Then** EE capabilities remain enabled and the license state is reported as "in grace" rather than "valid" or "unlicensed".
7. `AC-071-07` **Given** a license expired past the grace window, **When** entitlements are resolved, **Then** EE capabilities deactivate — no license or tenant data is touched, only feature access.

## Cloud deployments

8. `AC-071-08` **Given** a Cloud (non self-host) deployment, **When** entitlements are resolved, **Then** the license mechanism never activates and entitlements resolve from the billing tier matrix exactly as they would without EE licensing existing at all.

## End-to-end behavior

9. `AC-071-09` **Given** a self-hosted instance with a valid enterprise license and a billing row still on the free tier, **When** an admin uses an EE capability such as custom roles, **Then** it works end-to-end and the action appears in the audit trail — proving the license, not the billing tier, unlocked it.
