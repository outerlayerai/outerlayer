# Workers — Acceptance Criteria

Registering and running machine-side agent workers against an app: launching
one-shot and persistent worker runs, the worker runtime's contract for
executing a task and pushing its results back, and who can see or control a
tenant's workers.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Launching a worker run

1. `AC-061-01` **Given** an operator with write access to an app submits a task prompt and agent, **When** the worker is launched, **Then** a run is created in `queued` status and is re-readable with that exact status.
2. `AC-061-02` **Given** an operator submits an unknown agent id, **When** the launch is attempted, **Then** it is rejected before any entitlement check or compute dispatch, and the operator sees an "unknown agent" message.

## Persistent worker workspaces and follow-up turns

3. `AC-061-03` **Given** an operator starts a persistent worker environment, **When** the workspace is created, **Then** it is re-readable in a `creating` state, scoped to the app it was created under.
4. **Given** an active workspace, **When** an operator sends a follow-up task against it, **Then** the turn is recorded against that same workspace rather than starting a new one.
5. `AC-061-05` **Given** a follow-up turn names an environment id that does not exist, **When** it is submitted, **Then** no run is dispatched and the operator sees an "environment not found" message.

## Run outcome and landed changes

6. `AC-061-06` **Given** a worker's agent edits files while completing its task, **When** the run finishes, **Then** its outcome is recorded as `changes` and the edited files are attached to a branch — with any files the operator attached to the task excluded from that diff.
7. `AC-061-07` **Given** a worker's agent completes its task without editing any files, **When** the run finishes, **Then** its outcome is recorded as `no_changes` with no branch attached.

## Run failures

8. `AC-061-08` **Given** a worker cannot clone the target repository, **When** the runner reports back, **Then** the run ends in a terminal `failed` status carrying a `clone_failed` code, never left in a non-terminal state.
9. `AC-061-09` **Given** a worker's agent runs past its wall-clock cap, **When** the cap is hit, **Then** the run ends in a terminal `timed_out` status carrying a `wall_clock_exceeded` code.

## Cancelling a run

10. `AC-061-10` **Given** a non-terminal run (queued, provisioning, running, or pushing), **When** an operator cancels it, **Then** the run transitions to a terminal `cancelled` status.
11. `AC-061-11` **Given** a run has already reached a terminal status, **When** an operator cancels it again, **Then** the cancel is a no-op and the run's status is unchanged.

## Access, tenancy, and permissions

12. `AC-061-12` **Given** a user operating under an org they are not a member of, **When** they request that org's worker runs, **Then** they see none of them, even when probing for a run by its exact id.
13. `AC-061-13` **Given** a user holds only read access on an app, **When** they attempt to cancel one of its runs, **Then** the action is denied before any status change, distinct from and in addition to the database's own row-level denial.

## Credential handling

14. `AC-061-14` **Given** a worker's git operation fails, **When** the failure is surfaced to the operator, **Then** any embedded repository credentials are redacted from the reported error while the rest of the diagnostic remains readable.
