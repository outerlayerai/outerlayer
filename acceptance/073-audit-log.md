# Audit Log — Acceptance Criteria

The consolidated audit trail: what gets recorded, who may view a tenant's
trail, and the tamper-evidence guarantees an auditor relies on.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## What gets recorded

1. `AC-073-01` **Given** a platform-admin action or a tenant-visible access-control change occurs, **When** it is recorded, **Then** the entry captures the actor (human or machine), the action type, the target, and the before/after state.
2. `AC-073-02` **Given** platform-scoped events and tenant-scoped events both occur, **When** they are recorded, **Then** each is tagged with its owning scope and the two coexist in the same trail without collision.

## Viewing requires the Enterprise plan

3. `AC-073-03` **Given** a tenant lacks the audit-log entitlement, **When** it attempts to list the audit log, view an entry's detail, or export the log, **Then** each operation is denied with a message naming the Enterprise plan requirement.
4. `AC-073-04` **Given** a tenant holds the audit-log entitlement but the caller lacks the audit-log read permission, **When** it calls the list, detail, or export actions, **Then** each is denied before the underlying service runs.

## Tenancy of audit entries

5. `AC-073-05` **Given** an entitled tenant lists its audit log or fetches an entry's detail, **When** the query runs, **Then** only that tenant's own entries are returned — never another tenant's entries and never platform-scoped entries.

## Immutability and tamper evidence

6. `AC-073-06` **Given** an audit-log entry has been written, **When** anything other than the write seam itself attempts to update or delete it, **Then** the database rejects the change.
7. `AC-073-07` **Given** the sequence of audit-log entries, **When** an entry is altered or removed after the fact, **Then** the hash chain linking each entry to its predecessor makes the tamper detectable.

## Export

8. `AC-073-08` **Given** an entitled tenant exports its audit log, **When** the CSV is generated, **Then** it never includes the tamper-evidence chain internals (sequence number, hashes) and neutralizes spreadsheet formula injection in attacker-controlled values.
