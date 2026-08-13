# Terms of Service Acceptance — Acceptance Criteria

Recording and enforcing user agreement to the terms of service / privacy
policy: when acceptance is required, what is recorded, how re-acceptance is
handled on a new version, and who can read or write the acceptance record.

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

## Requiring acceptance

1. `AC-078-01` **Given** an authenticated user with no terms agreement record, **When** they navigate to a non-exempt authenticated route, **Then** they are redirected to the blocking terms-agreement screen with the originating path preserved for return.
2. `AC-078-02` **Given** the terms check fails or throws (service outage), **When** `TermsGuard` evaluates the route, **Then** access is allowed rather than locking the user out.

## Recording an agreement

1. `AC-078-03` **Given** a user agrees to the terms, **When** the agreement is recorded, **Then** a row is written carrying the terms version, an `agreed_at` timestamp, and a consent type that defaults to `explicit` when not specified.
2. `AC-078-04` **Given** a user has already agreed to a given terms version, **When** they attempt to record agreement to that same version again, **Then** the write is rejected by a unique constraint on `(user_id, terms_version)` and no duplicate row is created.
3. `AC-078-05` **Given** a consent type outside `explicit`/`implicit` is submitted, **When** the row is inserted, **Then** the database check constraint rejects it.

## Re-acceptance on a new version

1. `AC-078-06` **Given** a user has agreed to any past terms version, **When** the current terms version is bumped, **Then** the user is not required to re-accept — status checks report `needsCurrentVersion: false` and the guard does not block them.

## Reading and writing acceptance records (RLS)

1. `AC-078-07` **Given** the `terms_agreement` table, **When** an authenticated user queries it, **Then** they see only their own agreement rows, while the service role can read and write all rows.
2. `AC-078-08` **Given** an existing agreement row, **When** an authenticated user (not the service role) attempts to UPDATE or DELETE it, **Then** row-level security blocks the write and the record is unchanged — the table is append-only.
