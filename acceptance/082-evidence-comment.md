# Evidence Comment v0 — Verdict and Commit Provenance — Acceptance Criteria

The PR session comment (057) evolved into an evidence comment: it opens with
a verdict, states whether the PR's commits are accounted for by recorded
sessions, and records every evaluation for measurement against merge/revert
outcomes. The copy and layout source of truth is the "Evidence on the PR"
design; the matching and multi-session semantics come from the validators
design (`commits-from-sessions`).

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions. Ids are written, never derived from position; never renumber
one. Retire one by deleting the line and the citation together.

Copy note: the verdict templates below are the design's, verbatim. One
deliberate deviation is on record: the amber template "Look at {N} things
before merging" renders the grammatical singular ("1 thing") when exactly
one fact is flagged — the design shows only N ≥ 2 and the product does not
print "1 things".

## Verdict

1. `AC-082-01` **Given** an evidence evaluation, **When** the comment renders, **Then** it OPENS with exactly one of three verdict lines, copy verbatim from the design: "Everything checks out — a quick review should be enough" when every displayed fact passes · "Look at {N} things before merging" when any fact is flagged (N = flagged facts; singular "thing" at N = 1, see the copy note) · "We can't verify this PR — review it fully" only when a red-class fact fires. In this slice commit provenance — amber-class — is the only fact that can flag, so the red verdict cannot occur yet; its copy is still pinned so the first red-class fact is not a copy change.

## Commit provenance

2. `AC-082-02` **Given** a PR with confirmed session links and a readable commit list, **When** the comment renders, **Then** it states "{k} of {n} commits came from recorded sessions", where a commit counts as recorded when it shares a ≥7-character SHA prefix (either direction, case-insensitive) with the union of ALL confirmed sessions' recorded commits. k < n flags the fact amber and NAMES the unrecorded commits by short sha. Unrecorded commits alone never produce the red verdict. An unreadable commit list omits the fact rather than asserting a pass or a flag it cannot know.

## Layout

3. `AC-082-03` **Given** a PR with confirmed session links, **When** the comment renders, **Then** it follows the design's layout in order: the verdict line, then one aggregated metadata line (session count when more than one, agent breakdown, summed duration and cost labeled as sums over linked sessions, a session link), then the stated facts, then the per-session detail table the comment has always carried — with each session's deep link still reachable.

## Existing guarantees

4. `AC-082-04` **Given** the redesigned renderer, **When** any body renders, **Then** the guarantees of 057 hold, each RE-ASSERTED against the new renderer rather than assumed: exactly one comment per `(tenant, repository, PR)` via the stable marker identity; no human names, actor fields, or transcript content in the body; branch-matched links still marked *(inferred)*; and the 64 KB body-size ceiling behavior (truncate the table, keep the newest, name the remainder).

## Late-syncing sessions

5. `AC-082-05` **Given** a PR whose candidate links are all still pending, **When** the comment renders, **Then** it shows "waiting for session evidence"; **When** a link later confirms, **Then** the same comment is edited in place — verdict, provenance fact, and metadata appear with no human action, never a second comment.

## Human-only PRs

6. `AC-082-06` **Given** a PR with no candidate session links at all — nothing confirmed, nothing pending, **When** the refresh runs, **Then** no comment is posted, no identity row is created, and no evaluation is recorded: a human-only PR is left alone.

## Determinism

7. `AC-082-07` **Given** unchanged inputs, **When** the evaluation and the comment are recomputed, **Then** the evaluation is identical and the body is byte-identical — no wording, ordering, or number varies between runs.

## Recording

8. `AC-082-08` **Given** any evaluation of a PR with candidate links, **When** the refresh runs, **Then** the verdict and its facts are stored per `(tenant, repository, pr_number)` in `pr_evidence_evaluation` — at evaluation time, independent of whether the GitHub write succeeds — with consecutive identical evaluations stored once, so "did flagged PRs go bad more often" is answerable against `pull_request.merged_at`/`reverted_at` from day one.
