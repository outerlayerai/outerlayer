# Git Connection — Acceptance Criteria

Connecting an app to a git provider repository, the tenancy a connection
lands under, resolving a provider instance for a connected repo, and the
repo-level state GitHub webhooks keep in sync (pull request lifecycle and
review milestones). PR-comment behavior is covered separately in
`acceptance/057-pr-session-comment.md` and is out of scope here.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Connection tenancy

1. `AC-068-01` **Given** the OAuth callback completes with a signed connect-state naming a tenant that differs from the actor's session claim, **When** the connection is written, **Then** it lands under the signed-state tenant, never the claim tenant.
2. `AC-068-02` **Given** a connection has landed under one tenant, **When** a member of a different tenant looks for it, **Then** it is invisible to them — neither tenant can see or edit the other's connection.
3. `AC-068-03` **Given** a signed connect-state names a tenant the acting user does not belong to, **When** the callback attempts the write, **Then** it is rejected and no connection is written for that app, under any tenant.
4. `AC-068-04` **Given** a single-org user's signed state names their only org, **When** the connect completes, **Then** the connection row lands under that tenant normally.

## Provider resolution

5. `AC-068-05` **Given** an app has a git connection row for a provider, **When** code resolves a provider instance for that app to act on the repo, **Then** it authenticates using the installation id stored on that row — no separate credential exchange is involved.

## Webhook-tracked pull request lifecycle

6. `AC-068-06` **Given** a connected repo, **When** any pull request on it is opened, **Then** it is tracked with its lifecycle state, branches, and timestamps — regardless of whether it touches app-relevant paths.
7. `AC-068-07` **Given** a tracked pull request receives a `synchronize` event, **When** the webhook is processed, **Then** the existing tracked row is updated in place (head sha advances), never duplicated.
8. `AC-068-08` **Given** a tracked pull request is closed or merged, **When** the webhook fires, **Then** the row is marked accordingly, stamped with the payload's timestamps.
9. `AC-068-09` **Given** a review is submitted on a pull request that isn't yet tracked, **When** the review webhook is processed, **Then** the pull request row is healed from the embedded PR object rather than being dropped.
10. `AC-068-10` **Given** a bot account submits a review, **When** review milestones are computed, **Then** the bot's review is excluded — it must never appear to shorten review pickup time.
11. `AC-068-11` **Given** tracked pull request rows, **When** a tenant member with the read permission queries them, **Then** they can read them, but the rows are written only by the service role — never by a tenant-scoped client directly.

## Repo access revocation

12. **Given** the GitHub App's access to a repository is revoked, **When** the installation webhook reports the repository removed, **Then** the app's git connection to that repo is deleted, disconnecting it.
