# Org Lifecycle — Acceptance Criteria

Organization settings and rename, member removal, temporary-access grants
and their confinement, and organization/tenant cascade deletion.

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

## Organization settings

1. `AC-065-01` **Given** an org owner submits a new organization name, **When** the rename is saved, **Then** the organization's stored name is updated and the new name is returned.
2. `AC-065-02` **Given** a rename targets a tenant the caller cannot see (an unknown or inaccessible tenant), **When** the write is attempted, **Then** it fails outright rather than silently reporting success.

## Member removal

1. `AC-065-03` **Given** a caller without permission to remove members, **When** they attempt to remove one, **Then** the request is denied before any removal is attempted.
2. `AC-065-04` **Given** an organization with exactly one owner, **When** removal of that owner is attempted, **Then** the removal is refused.
3. `AC-065-05` **Given** an organization with more than one active owner, **When** one of them is removed, **Then** the removal succeeds.
4. `AC-065-06` **Given** an organization with exactly one owner, **When** that owner's role is changed to a non-owner role, **Then** the change is refused — ownership must be transferred to another member first.
5. `AC-065-07` **Given** an organization with exactly two owners, **When** both are demoted at the same time, **Then** at least one owner always remains.

## Temporary-access grants

1. `AC-065-08` **Given** a platform admin holds an active temporary-access grant for a tenant, **When** a different platform admin looks up a grant for that same tenant, **Then** nothing is returned — a grant is confined to the admin who created it, even when the tenant id is known.

## Organization / tenant cascade deletion

1. `AC-065-09` **Given** an organization with apps and their dependent records (git connections, context data, notifications, and the rest), **When** the organization is deleted, **Then** every one of its dependent records is removed along with it.
2. `AC-065-10` **Given** two unrelated organizations, **When** one is deleted, **Then** the other's data is left completely untouched.
3. `AC-065-11` **Given** an organization with an active temporary-access grant, **When** the organization is deleted, **Then** its temporary-access grant is deleted along with it.
4. **Given** a platform admin is deleting an organization, **When** they confirm the deletion, **Then** they must first confirm the organization's exact name before the deletion proceeds.
