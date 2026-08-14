# User-authored validators: policy file and declarative customs

The repo-owned evidence policy behind the PR comment: which validators
display and at what level, plus the repo's own custom validators —
selected, leveled, and written as versioned files in the customer's
repository, evaluated by the same fact layer as the built-ins.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions. Ids are written, never derived from position; never renumber.

## The policy file

1. `AC-085-01` **Given** a policy file leveling validators, **When** the evaluation applies it, **Then** `off` removes the row entirely, overrides beat defaults and custom levels, and an absent policy leaves the built-in defaults unchanged.
2. `AC-085-02` **Given** a PR, **When** its policy is read, **Then** every file comes from the PR's BASE branch — a PR editing the policy is judged under the policy it started from.

## Custom validators

3. `AC-085-03` **Given** a custom requiring `session.ran`, **When** the required command ran (through wrappers and prefixes), **Then** the row passes with the matched run's turn as its proof and the `row:` copy verbatim.
4. `AC-085-04` **Given** a scoped custom whose required proof does not exist, **When** it evaluates, **Then** the row flags with the copy plus "not proven" — claiming only that the proof was not found.
5. `AC-085-05` **Given** a custom scoped by `when.paths`, **When** the PR's changed files do not match — or could not be read — **Then** no row renders.
6. `AC-085-06` **Given** a session whose capture lacks a custom's needed fact families, **When** it evaluates, **Then** no row renders — never a silent pass, never a false fail.

## Load-time honesty

7. `AC-085-07` **Given** a policy that exists but is broken (bad YAML, an unknown preset, a dangling name), **When** the comment renders, **Then** exactly one error row names the file and the problem, the broken file contributes nothing, and the rest of the comment renders.
8. `AC-085-08` **Given** any custom validator, **When** it flags, **Then** the flag is amber — a custom can never produce the "can't verify" verdict — and a `kind: signal` custom never renders as a validation row.

## Levels and doctrine

9. `AC-085-09` **Given** a validator leveled `info`, **When** it flags, **Then** the row still renders but the flag is excluded from the verdict and its count.
10. `AC-085-10` **Given** an `emitted:` requirement, **When** its name is declared but no delivery channel exists, **Then** an unknown suppresses the row rather than flagging it — and an undeclared name is a load error, not a silent no-op.
11. `AC-085-11` **Given** identical policy sources and sessions, **When** evaluation runs twice, **Then** the results are deeply equal.
