# App Management — Acceptance Criteria

Creating, renaming, and deleting apps; app-level reads; app/tenant
consistency; and the environments that live under an app.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Creating an app

1. `AC-069-01` **Given** an actor holding app-creation permission submits a unique app name, **When** the create request is processed, **Then** the new app is scoped to the actor's own tenant, never a tenant the actor merely names.
2. `AC-069-02` **Given** an app name already used within the tenant, **When** an actor submits a create request with that name, **Then** the request is rejected as a duplicate and no second app row is created.
3. `AC-069-03` **Given** an actor lacking app-creation permission, **When** they submit a create request, **Then** it is denied before any row is written.
4. `AC-069-04` **Given** a tenant that has reached its plan's app-count limit, **When** an actor attempts to create another app, **Then** the request is rejected with a message naming the limit and the tenant's current count, and no row is created.
5. `AC-069-10` **Given** a new app is created, **When** creation completes, **Then** a default environment for the app exists without any separate action being required.

## Renaming an app

1. `AC-069-05` **Given** an actor renames an app's display name, **When** the rename is submitted, **Then** the display name updates while the app's URL-stable identifier is left unchanged.
2. `AC-069-06` **Given** an actor clears an app's display name, **When** the rename is submitted with no override, **Then** the app falls back to displaying its identifier instead of a stale name.

## Deleting an app

1. `AC-069-07` **Given** an actor deletes an app, **When** the deletion completes, **Then** the app and its dependent resources (git connection, environments, API keys) are removed, and API keys issued for that app stop authorizing requests.

## App-level reads and tenancy

1. `AC-069-08` **Given** a member of one tenant, **When** they list or read apps, **Then** they see only their own tenant's apps, and requesting under a different tenant's context returns none of that tenant's apps rather than an error that would confirm its existence.
2. `AC-069-09` **Given** any resource that belongs to an app (API key, saved view, or similar), **When** it is written with a tenant id that disagrees with the app's owning tenant, **Then** the write is rejected as a database-level invariant, independent of which role performed it.

## Environments under an app

1. `AC-069-11` **Given** a tenant that has reached its plan's per-app environment limit, **When** an actor attempts to create another persistent environment, **Then** the request is rejected with a message naming the limit and tier, while ephemeral preview environments are never counted toward that limit.
2. `AC-069-12` **Given** an actor names an environment, **When** the name is validated, **Then** it must fall within the allowed length and character set or the request is rejected with a specific reason.
