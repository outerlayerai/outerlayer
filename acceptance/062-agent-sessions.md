# Agent Sessions — Acceptance Criteria

The agent-sessions list, its filters, session and span detail views, and the
tenancy rules that govern who may see which sessions.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Sessions list

1. `AC-062-01` **Given** a repo with agent sessions, **When** a user opens the sessions list, **Then** they see the repo scope, a total count, and one row per session.
2. `AC-062-02` **Given** the active filters match no sessions, **When** the list renders, **Then** the user sees an explicit empty state rather than a blank body.

## Filtering: signals, topic drill-down, and saved views

1. `AC-062-03` **Given** a user picks a trajectory signal (hands-on, denied, tool errors, provider errors, or clean), **When** the filter is applied, **Then** only sessions matching that signal are returned, and the same signal narrows both the count and the origin breakdown.
2. `AC-062-04` **Given** a deep link carries a signal token the app doesn't recognize, **When** the list loads, **Then** it falls back to no active signal filter instead of silently hiding every session.
3. `AC-062-05` **Given** a user drills into a topic from another view, **When** the sessions list opens scoped to that topic, **Then** a chip labeled with the facet and topic name is shown, and clearing it drops the topic scoping and returns to the full list.
4. `AC-062-06` **Given** a user saves a named filter view, **When** a teammate in the same tenant and app opens the sessions list, **Then** the saved view is available to them too — saved views are shared within the tenant/app, not private to their creator.

## Session and span detail

1. `AC-062-07` **Given** a user opens a session's detail view, **Then** the page is titled with the session and captioned with its agent, actor, project, and capture tier.
2. `AC-062-08` **Given** a session has no known cost, **When** its detail view renders, **Then** the cost is shown as unpriced ("—") rather than a misleading $0.00.
3. `AC-062-09` **Given** a session contains three or more consecutive failed edits to the same file, **When** its detail view renders, **Then** a warning names the file and the length of the run.
4. `AC-062-10` **Given** a session is linked to one or more pull requests, **When** its detail view renders, **Then** each linked PR's outcome is shown in an outcome strip, which is hidden entirely for sessions touching no scored PR.
5. `AC-062-11` **Given** a turn's recorded output exceeds the display cap, **When** the session detail is served, **Then** the output is truncated to the cap rather than returned in full.

## Tenancy and permissions

1. `AC-062-12` **Given** a member holds only the self-read permission, **When** they open the sessions list, **Then** they see only sessions attributed to their own seat.
2. `AC-062-13` **Given** a member holds the team-read permission (granted by default to owners and admins, grantable to others), **When** they open the sessions list, **Then** they see sessions from every teammate, not just their own.
3. `AC-062-14` **Given** a member without team-read tries to open another actor's session by id, **When** the detail view is requested, **Then** it resolves the same way as a session that never existed — nothing distinguishes "not yours" from "not found."
4. `AC-062-15` **Given** two tenants each have their own agent sessions, **When** a user lists sessions under their tenant, **Then** only their tenant's sessions are ever returned, never another tenant's.
