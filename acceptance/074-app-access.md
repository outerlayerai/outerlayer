# App Access — Acceptance Criteria

Per-app access restrictions: assigning a member a role scoped to a single
app rather than the whole org, and restricting a member to only the apps
they've been explicitly granted.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Assigning per-app roles

1. `AC-074-01` **Given** a tenant entitled to per-app roles, **When** an admin assigns a member a read/write/admin role on a specific app, **Then** that role governs the member's access to that app.
2. `AC-074-02` **Given** a tenant not entitled to per-app roles, **When** any per-app role mutation (assign, update, revoke, bulk assign) is attempted, **Then** it is denied and no row is written.
3. `AC-074-03` **Given** an org owner, **When** an admin attempts to assign or bulk-assign a per-app role to them, **Then** the attempt is rejected — owners always retain full access and cannot be scoped down by a per-app role.
4. `AC-074-04` **Given** a member is granted a custom role scoped to a specific app, **When** it is assigned, **Then** that custom role — not a built-in read/write/admin role — governs the member's access to that app.

## Restricting a member to explicit apps

5. `AC-074-05` **Given** a member is marked app-scoped with no role on a given app, **When** their access to that app is checked, **Then** they are denied.
6. `AC-074-06` **Given** a member is unrestricted (not app-scoped), **When** their access to any app is checked, **Then** they have access regardless of whether an explicit per-app role exists for that app.
7. `AC-074-07` **Given** an admin toggles a member between app-scoped and unrestricted, **When** the change is saved, **Then** it immediately governs the member's effective app access.

## Authorization

8. `AC-074-08` **Given** the assign, update, revoke, and list per-app-role actions, **When** called, **Then** each requires its corresponding permission independent of the entitlement check, so an unauthorized caller is denied before the service runs.
