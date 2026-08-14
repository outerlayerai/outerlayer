# Issues integration: the spec on the pull request

The linked issue becomes the source of what needs proving: the comment
names its closing issues, their "Validation required" checklists become
required-evidence rows, validators scope by issue context, and a
`proof: test` criterion binds the spec to a citing test in the code.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions. Ids are written, never derived from position; never renumber.

## The spec, named

1. `AC-086-01` **Given** a PR with declared closing issues, **When** the comment renders, **Then** they appear under the verdict as "for #N — title" — and a PR with none renders no issue line, never a guess.

## Asks

2. `AC-086-02` **Given** a "Validation required" checklist on a linked issue, **When** the comment renders, **Then** each entry is a row sourced to its issue: a validator entry proven by that validator's own result with its refs, a typed-proof entry by an artifact of the required kind.
3. `AC-086-03` **Given** an unmet ask, **When** the verdict derives, **Then** the flag is amber — "look at N things", never "can't verify".
4. `AC-086-04` **Given** an issue body attempting to disable, level, or waive anything, **When** the evaluation runs, **Then** it is identical except for any legitimately added asks — and no level can mute an ask.
5. `AC-086-05` **Given** a validator scoped by `when.issue.type` or `when.issue.labels`, **When** a linked issue matches, **Then** it applies — and with no linked issue or no match it is absent, never a false fail.
6. `AC-086-06` **Given** asks written as free prose outside the block, **When** the issue is parsed, **Then** nothing is produced — only structure counts.
7. `AC-086-07` **Given** a dangling or malformed entry, **When** the comment renders, **Then** one error row names the entry and the problem, and the rest renders.

## Spec-to-code binding

8. `AC-086-08` **Given** a criterion declaring `proof: test`, **When** a changed test file at the PR head cites its id, **Then** the proof cell names the citing file — and claims nothing about the test having run; without a citation the cell names the absence.

## Freshness

9. `AC-086-09` **Given** an edited "Validation required" block, **When** the comment refreshes, **Then** the rows reflect the issue's current asks — and unchanged inputs render identically.
