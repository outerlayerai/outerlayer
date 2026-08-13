# API Keys & Gateway Authentication — Acceptance Criteria

API key lifecycle management in the dashboard, CLI developer-key issuance, and
bearer-token authentication/authorization enforcement at the gateway.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

Scenarios without an id are not yet proven by a test; they are tracked debt,
not requirements to skip.

## Creating and scoping API keys

1. `AC-060-01` **Given** a key holder requests specific permissions they hold, **When** they create an API key, **Then** the key is minted with exactly those permissions and the plaintext secret is shown once.
2. `AC-060-02` **Given** a key holder requests a permission they do not themselves hold, **When** they attempt to create a key, **Then** the request is rejected and no key is created.
3. `AC-060-03` **Given** a tenant is at its API key limit, **When** a user attempts to create another key, **Then** creation is denied with an entitlement error.
4. `AC-060-04` **Given** a user is creating a key scoped to environment kinds rather than a single pinned environment, **When** no kind is selected, **Then** key creation is blocked until at least one kind is chosen.

## Revoking and updating keys

1. `AC-060-05` **Given** a caller lacks permission to delete a key on its app, **When** they attempt to delete it, **Then** the key is left untouched, the request is denied, and the denial is audited.
2. **Given** an API key is deleted, **When** the deletion completes, **Then** the key stops authenticating immediately and cannot be restored or un-revoked.
3. `AC-060-06` **Given** a key holder attempts to grant an existing key permissions beyond what they themselves hold, **When** they update the key's permissions, **Then** the update is rejected and the key's permissions are unchanged.

## CLI developer-key issuance

1. `AC-060-07` **Given** a request to issue a CLI developer key has no valid authenticated session, **When** the request is made, **Then** it is rejected and no key is issued.
2. `AC-060-08` **Given** a developer requests a CLI dev key for one of their apps, **When** the key is issued, **Then** it carries a fixed `trace.write` scope, a distinguishing dev-key prefix, and a 30-day expiry, regardless of what the requester asked for.
3. `AC-060-09` **Given** a developer requests a dev key for an app that does not belong to their tenant, **When** the request is made, **Then** it is denied and no key is issued.
4. `AC-060-10` **Given** an existing CLI dev key is refreshed, **When** the refresh completes, **Then** a new secret and key id are issued while the key's name, app, and environment scope are preserved.

## Gateway request authentication and tenant scoping

1. `AC-060-11` **Given** a bearer-authenticated request supplies an explicit tenant header, **When** the request is scoped, **Then** the header's tenant governs the request even when it differs from the session's own tenant claim.
2. `AC-060-12` **Given** a bearer-authenticated request supplies a tenant header naming a tenant the caller does not belong to, **When** the request is authenticated, **Then** it is denied outright, with no fallback to the caller's own tenant claim.
3. `AC-060-13` **Given** a request targets another tenant's API key by guessing its identifiers, **When** the request is scoped to the caller's own tenant, **Then** it matches no rows and the other tenant's key is left intact.
4. **Given** an unknown, a revoked, and an expired API key, **When** each is presented to the gateway, **Then** all three are rejected with the same authentication failure, disclosing no signal about which condition applies.
