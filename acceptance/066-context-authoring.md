# Context Authoring — Acceptance Criteria

The write side of the Context surface: editing and saving files, deleting
them, batching multi-file commits, and the git connection those writes land
through — plus the data guarantees a synced snapshot and the read service
built on top of it must hold. The Overview analytics surface and the Files
explorer UI are covered separately in `acceptance/058-context-overview.md`;
this file does not repeat those criteria.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Editing and saving files

1. `AC-066-01` **Given** a user creates a context file at a path that does not yet exist, **When** the create action runs, **Then** the file is written to the connected repository and the app's file tree reflects it.
2. `AC-066-02` **Given** a user attempts to create a file at a path that already exists in the connected repository, **When** the create action runs, **Then** it is rejected as a conflict naming the existing content, and no commit is made.
3. `AC-066-03` **Given** a user edits a file whose base version no longer matches the file's current content in the connected repository, **When** the save is submitted, **Then** it is rejected as a conflict describing the current remote version, rather than silently overwriting the concurrent change.

## Batch commits and file removal

4. `AC-066-04` **Given** a user changes more than one file in a single editing session, **When** the changes are saved, **Then** all of them land as one atomic commit — either every file is written or none is.
5. `AC-066-05` **Given** a user deletes a file, **When** the deletion is saved, **Then** the file is removed from the connected repository at the current head through the same commit path as an edit.
6. `AC-066-06` **Given** a user deletes a skill, **When** the deletion runs, **Then** every file under that skill's directory is enumerated directly from the connected repository, not only from what the local mirror last recorded.

## Reading remote state before writing

7. `AC-066-07` **Given** a user is about to overwrite a file, **When** the editor needs to detect a conflicting concurrent change, **Then** the file's current content and version can be read fresh from the connected repository's branch head, independent of the local mirror.

## Git write path prerequisites and publish status

8. `AC-066-08` **Given** an app has no connected git repository, **When** a write action (save, create, commit, or delete) is attempted against it, **Then** it reports the app as not connected rather than attempting any git operation.
9. `AC-066-09` **Given** one or more pull requests were previously opened to publish context changes, **When** their status is checked, **Then** any that have since been merged or closed are reported back, so the UI knows its local view of open publishes is stale.

## Tenant and permission boundaries

10. `AC-066-10` **Given** a write action names an app that belongs to a different tenant than the acting user's request, **When** the action runs, **Then** it is denied with a forbidden error and no repository write occurs.
11. `AC-066-11` **Given** a user is a member of more than one organization and their session claim names an organization other than the one in the URL, **When** they save a context change, **Then** the save resolves the git connection for the organization in the URL, not the one in the session claim.

## Snapshot and sync data integrity

12. `AC-066-12` **Given** a synced snapshot belongs to one app, **When** any row describing its content (a tree entry, the head pointer, or a sync event) is written under a different app, **Then** the write is rejected — a snapshot's content can never be attributed to an app that doesn't own it.
13. `AC-066-13` **Given** a superseded snapshot is pruned, **When** the deletion runs, **Then** its tree entries are removed but the sync-event audit trail for that push survives, with its snapshot reference cleared rather than the audit row itself being destroyed.

## Read service contract

14. `AC-066-14` **Given** an app has synced more than once, **When** the read surface is asked for an earlier snapshot instead of the current head, **Then** it returns that snapshot's content, not the latest one.
15. `AC-066-15` **Given** a tracked file was too large to mirror and has no stored content, **When** it is read, **Then** it is reported as oversize with no content, rather than the read failing or returning stale data.
