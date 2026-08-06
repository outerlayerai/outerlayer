# Agent Sessions on the Pull Request — Acceptance Criteria

A single, continuously-edited bot comment on each PR of a connected repo,
listing the agent sessions that produced it.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

These scenarios are transcribed from GitHub issue #10, with the amendments
recorded in the implementation plan applied so the criteria match what ships:
scenario 6 narrows to provider errors and error storms (stuck-edit-retry-loop
badging is deferred — see that scenario's note); the "missing cost renders as
an em dash" requirement is dropped for cost specifically, in scenario 11; and
"one bot comment per PR" is restated as one comment per
`(tenant, repository, PR)` throughout.

## Comment presence and identity

1. **Given** a connected repo and a PR with at least one verified session link, **When** a reviewer opens the PR, **Then** a single bot comment lists each linked session with topic labels when available, duration, cost, and every model the session used, plus a deep link to that session's existing dashboard detail page; the comment header rolls up linked-session count, total agent time, and total cost, labeled as sums over linked sessions.
2. **Given** the comment exists and another session linking the same PR syncs later — including one addressing review feedback on the open PR — **When** the link is verified, **Then** the existing comment is edited to include it, never a second comment: one comment per `(tenant, repository, PR)`, even when the PR has sessions across more than one connected app in that tenant.
3. **Given** a listed session accrues more work after its row first renders, **When** the comment is next edited, **Then** that row and the header totals reflect the session's current duration, cost, models, and topics — the comment renders present state, never a first-sight snapshot.
4. **Given** a PR with no verified session links, **When** the bot comments, **Then** the comment states no agent sessions are linked yet, and upgrades in place to the session table if sessions arrive later.

## Link provenance

5. **Given** a session linked only by branch inference, **When** it renders, **Then** it is visibly marked as inferred rather than presented as certain.

## Trouble signals

6. **Given** a session with provider errors or an error storm, **When** the comment renders, **Then** that session's row carries an issue marker. Stuck-edit-retry-loop badging, present in the original story, is **deferred out of this criterion**: the rollup row the comment renders from doesn't carry the span sequence the edit-loop detector needs, and computing it per row would mean a span fetch per session on every comment refresh. Only provider errors and error storms gate the marker.

## Topic labels

7. **Given** a session whose facets have clustered into topics, **When** the comment renders, **Then** the row shows those topic labels as plain text — from any facet, built-in or custom — and never facet summary text; a session with no topics yet renders without labels and gains them on a later comment edit.

## Privacy

8. **Given** a reader without dashboard access, **When** they read the comment, **Then** they see topic labels, durations, and costs — but no human names and no transcript content; a transcript requires the deep link and dashboard authentication.

## Dashboard link

9. **Given** several sessions link one PR, **When** a lead follows the comment's dashboard link, **Then** they land on the sessions list filtered to that PR, showing all linked sessions and totals.

## Latency

10. **Given** an online machine with capture installed, **When** its session opens a PR — even mid-turn — **Then** the comment shows that session within the latency target (p50 ≤ 2 minutes, p90 ≤ 5 minutes), with no scheduled batch process in the path.

## Missing values

11. **Given** a session row is missing a title or has no topics, **When** the comment renders, **Then** the title renders as "untitled session" and the topics cell renders an em dash; a session's cost, however, always renders as a dollar amount — `$0.00` when `CostUsd` is genuinely zero — because recorded cost is a non-nullable value at rest and cannot be distinguished from zero, so the em-dash treatment does not apply to cost.
