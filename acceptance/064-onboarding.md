# Onboarding — Acceptance Criteria

Signup and registration (email + OAuth), organization creation, and the
getting-started checklist.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Registration

1. `AC-064-01` **Given** a visitor submits a valid email, password, and name, **When** registration runs, **Then** an auth user and profile are created but no organization, membership, or billing record — organization creation happens later, on the orgs page.
2. `AC-064-02` **Given** an email address that is already registered, **When** a second registration attempt uses it, **Then** the attempt is rejected with a generic failure message that does not confirm the address exists.
3. `AC-064-03` **Given** a user who already has a profile from an earlier OAuth sign-in, **When** they complete OAuth again (e.g. a repeat login), **Then** the same user is returned rather than a second profile being created.
4. `AC-064-04` **Given** a user who registered with one identity provider (email or Google), **When** they subsequently sign in with a GitHub identity on the same account, **Then** their profile's GitHub username is recorded.

## Organization creation

1. `AC-064-05` **Given** organization creation fails to set up billing, **When** the failure occurs, **Then** no organization or billing record is left behind — the attempt leaves no partial state.
2. `AC-064-06` **Given** an organization name that is already taken, **When** creation is attempted with that name, **Then** the attempt fails and any billing customer already created for the attempt is rolled back.
3. `AC-064-07` **Given** organization creation succeeds, **When** the flow completes, **Then** the organization and its billing record both exist and are visible to the creator.

## Getting-started checklist

1. `AC-064-08` **Given** a newly created app, **When** its checklist is read, **Then** the "create your first app" step is already shown complete, regardless of any other progress.
2. `AC-064-09` **Given** an app with only its creator as a member, **When** the checklist is read, **Then** the "invite a teammate" step is not done — a second active member is required.
3. `AC-064-10` **Given** an app with a GitHub App connection but no linked branch, **When** the checklist is read, **Then** the "link your repo" step is not done — both a live connection and a linked branch are required.
4. `AC-064-11` **Given** a caller who is not a member of the app's organization, or who names an app belonging to a different organization, **When** they request that app's checklist, **Then** the request is denied and no onboarding signal is returned.
