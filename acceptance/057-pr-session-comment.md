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

These scenarios are transcribed from the original feature story. Two
amendments were proposed against it; both have now been ruled on by the story
owner:

- Scenario 6 narrows to provider errors and error storms for the MVP.
  Stuck-edit-retry-loop badging is **deferred, not dropped** — see the TODO
  on that scenario.
- The "missing cost renders as an em dash" requirement is **kept** (scenario
  11). It was proposed for removal on the grounds that `CostUsd` is
  non-nullable at rest; that is a property of the storage, not of reality, so
  a cost we don't have renders as an em dash rather than as `$0.00`.

"One bot comment per PR" is restated as one comment per
`(tenant, repository, PR)` throughout. This is deliberate and confirmed: two
tenants that both track the same repository each get their own comment, since
neither can see the other's sessions and neither may edit the other's
comment.

## Comment presence and identity

1. `AC-057-01` **Given** a connected repo and a PR with at least one verified session link, **When** a reviewer opens the PR, **Then** a single bot comment lists each linked session with topic labels when available, duration, cost, and every model the session used, plus a deep link to that session's existing dashboard detail page; the comment header rolls up linked-session count, total agent time, and total cost, labeled as sums over linked sessions.
2. `AC-057-02` **Given** the comment exists and another session linking the same PR syncs later — including one addressing review feedback on the open PR — **When** the link is verified, **Then** the existing comment is edited to include it, never a second comment: one comment per `(tenant, repository, PR)`, even when the PR has sessions across more than one connected app in that tenant.
3. `AC-057-03` **Given** a listed session accrues more work after its row first renders, **When** the comment is next edited, **Then** that row and the header totals reflect the session's current duration, cost, models, and topics — the comment renders present state, never a first-sight snapshot.
4. `AC-057-04` **Given** a PR with no verified session links, **When** the bot comments, **Then** the comment states no agent sessions are linked yet, and upgrades in place to the session table if sessions arrive later.

## Link provenance

5. `AC-057-05` **Given** a session linked only by branch inference, **When** it renders, **Then** it is visibly marked as inferred rather than presented as certain.

## Trouble signals

6. `AC-057-06` **Given** a session with provider errors or an error storm, **When** the comment renders, **Then** that session's row carries an issue marker. Stuck-edit-retry-loop badging, present in the original story, is **deferred out of this criterion**: the rollup row the comment renders from doesn't carry the span sequence the edit-loop detector needs, and computing it per row would mean a span fetch per session on every comment refresh. Only provider errors and error storms gate the marker. **TODO:** restore stuck-edit-retry-loop badging once the rollup row carries enough span sequence to detect it without a per-session span fetch.
names "did the agent get stuck — edit-retry loops" as one of four motivating
questions, so this is a gap to close, not a settled scope — it needs a source
for the span sequence (or a precomputed loop signal on the rollup row) that
doesn't cost a span fetch per session per refresh.

## Topic labels

7. `AC-057-07` **Given** a session whose facets have clustered into topics, **When** the comment renders, **Then** the row shows those topic labels as plain text — from any facet, built-in or custom — and never facet summary text; a session with no topics yet renders without labels and gains them on a later comment edit.

## Privacy

8. `AC-057-08` **Given** a reader without dashboard access, **When** they read the comment, **Then** they see topic labels, durations, and costs — but no human names and no transcript content; a transcript requires the deep link and dashboard authentication.

## Dashboard link

9. `AC-057-09` **Given** several sessions link one PR, **When** a lead follows the comment's dashboard link, **Then** they land on the sessions list filtered to that PR, showing all linked sessions and totals **for the app the link is scoped to**. **Knowingly accepted gap:** the sessions list's `?pr=` filter is pinned to a single `app_id`, so on a PR whose sessions span more than one app the landing page shows a SUBSET of the comment's rows, with smaller totals — the comment's own table remains the complete picture. Closing it needs a tenant-scoped `?pr=` route (or a per-session route that needs no app in the path); until then the criterion is scoped to one app rather than claiming a match the product cannot make. See the TODO in `render.ts`.

## Latency

10. `AC-057-10` **Given** an online machine with capture installed, **When** its session opens a PR — even mid-turn — **Then** the comment shows that session with **no scheduled batch process in the path**: both the `pull_request` webhook and the session-sync queue deliver a refresh on their own.

    **What the bound tests prove, and what they don't.** The structural half — that neither trigger path routes through a batch process — is testable and is tested on both paths. The p50 ≤ 2 min / p90 ≤ 5 min numbers are **not** unit-testable: they depend on capture upload timing, queue delivery, and GitHub's own write latency. They are tracked as an **SLO against production telemetry**, not asserted here. A test claiming to prove them would be the more dangerous artifact.

## Missing values

11. `AC-057-11` **Given** a session row is missing a title or has no topics, **When** the comment renders, **Then** the title renders as "untitled session", the topics cell renders an em dash, and a session with no recorded cost renders an em dash rather than `$0.00` — `CostUsd` being non-nullable at rest makes "unknown" and "zero" indistinguishable in the data, and of the two readings the comment must not be the one that asserts the work was free.
