# Verification Facts — Acceptance Criteria

The fact layer and reference validators behind the evidence comment's
verification rows: span timelines → classified command runs and edits →
deterministic rule results.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions. Ids are written, never derived from position; never renumber.

## Red-then-green

1. `AC-083-01` **Given** a test command that failed and later passed with at least one edit between, **When** red-then-green evaluates a PR whose diff adds tests, **Then** it passes with the failing and passing runs as its refs.
2. `AC-083-02` **Given** new tests that were never observed failing, **When** red-then-green evaluates, **Then** the result is absent — never a flag and never red.
3. `AC-083-03` **Given** a session whose capture carries no command content, **When** a validator needing commands evaluates, **Then** the result is `not_checkable` — never a silent pass and never a false fail.

## Command reality: pipes and compounds

4. `AC-083-04` **Given** a failing test run whose piped exit code recorded `ok`, **When** facts are extracted with the run's output present, **Then** the run's reliable result is `fail` and it anchors red-then-green across differing pipe tails.
5. `AC-083-05` **Given** a test invocation buried mid-compound (after other statements or a heredoc), **When** the command classifies, **Then** the test segment is recognized — and heredoc CONTENT never classifies as a run.

## Tampering and bypass

6. `AC-083-06` **Given** a failing test made to pass by editing only test files, **When** no-test-tampering evaluates, **Then** it flags amber with the failure and the test edit as refs.
7. `AC-083-07` **Given** a git command carrying a hook-bypass flag, **When** no-test-tampering evaluates, **Then** it flags red-class with the command as its ref.
8. `AC-083-08` **Given** a commit message that merely mentions a bypass flag inside quotes, **When** bypass detection runs, **Then** it does not flag.

## Display doctrine

9. `AC-083-09` **Given** identical inputs, **When** a validator evaluates twice, **Then** the results are deeply equal.
10. `AC-083-10` **Given** a last test run whose scope is not provably the full suite, **When** tests-after-last-edit summarizes, **Then** the summary names the actual command instead of claiming totality.

## Comment wiring

11. `AC-083-11` **Given** a verification validator result of pass or flag, **When** the evidence comment renders, **Then** the result appears as a fact row using the validator's sentence verbatim with its turn refs — and absent/not_checkable results produce no row.
12. `AC-083-12` **Given** a red-class verification flag (a check-bypass), **When** the evidence verdict derives, **Then** the verdict is "unverifiable" — while amber verification flags only ever produce "look at N things".
