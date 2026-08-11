# Context Overview — Acceptance Criteria

An analytics-first Overview view as the Context surface's default landing:
stat tiles, ranked skills/MCP tables with adoption status, a needs-attention
worklist, and a URL-addressable side drawer for per-artifact detail. The
Files view becomes a pure explorer: folders expand in the tree, the editor
renders only files, and no usage figures appear anywhere in it — usage lives
only in the Overview.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Landing and rollup

1. `AC-058-01` **Given** an app with synced context and session telemetry, **When** a user with `context.read` opens the Context page with no params, **Then** the Overview renders skill and MCP-server counts split into active, quiet, and never, session coverage, and windowed activations — with no further interaction.
2. `AC-058-02` **Given** the Overview, **When** the time range changes, **Then** `range` updates in the URL and the figures are re-read for that window, whose deltas compare against the equal-length prior period.
3. `AC-058-03` **Given** more than 8 skills, **When** the Overview renders, **Then** the top 8 by activations show with an inline expander revealing the rest, and no pagination control exists.

## Status integrity

4. `AC-058-04` **Given** a repo skill with zero activations and at least one session in the lookback window, **When** the Overview renders, **Then** the skill shows a `never` status and appears in the needs-attention rail with a link to its file.
5. `AC-058-05` **Given** an app whose lookback window contains zero sessions, **When** the Overview renders, **Then** no `never` status appears anywhere, the delta rows show no prior data, and the first-run banner is shown.
6. `AC-058-06` **Given** activations recorded for a skill name no longer present in the repo, **When** the Overview renders, **Then** the row appears marked as removed from the repo and is excluded from the active/quiet/never counts.
7. `AC-058-07` **Given** an empty prior window, **When** deltas render, **Then** the tile shows no prior data rather than any computed percentage.

## Drill-down

8. `AC-058-08` **Given** the Overview, **When** a skill row is clicked, **Then** `skill=<name>` is added to the URL and a non-modal side panel shows the skill's figures, trend, sessions, and topics without navigating away.
9. `AC-058-09` **Given** a URL containing `view=overview&skill=<name>`, **When** it is opened directly, **Then** the Overview renders with the panel already open for that skill and its row highlighted.
10. `AC-058-10` **Given** an open detail panel, **When** it is closed, **Then** the `skill`/`server` param is removed and the range, sort, and top-N expansion state are preserved.

## Compatibility and degradation

11. `AC-058-11` **Given** a pre-existing link carrying `file=<path>` and no `view` param, **When** it is opened, **Then** the Files view renders with that file selected, exactly as before this feature.
12. `AC-058-12` **Given** the analytics store is unavailable, **When** the Overview renders, **Then** inventory-derived rows still display with em-dashes in the usage columns and a retry affordance is offered; the page never blanks.
13. `AC-058-13` **Given** a skill's `SKILL.md` open in the Files view, **When** it renders, **Then** the editor carries no usage UI at all — no Usage tab and no usage figures; usage lives only in the Overview.
14. `AC-058-14` **Given** the Files tree, **When** a skill directory is clicked, **Then** it expands or collapses in place and the editor pane does not change; the editor renders only when a file is opened.
