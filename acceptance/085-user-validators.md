# User-Authored Validators — Acceptance Criteria

Teams choose which checks run on their PRs and write their own, as plain
files in their repo: a policy file adopts and levels the built-in registry,
declarative custom validators state conditions over facts the engine already
computed, and checks that need compute run in the customer's CI and report
in with `outerlayer emit`. The judge executes no customer code — definitions
are data, and verdicts stay deterministic and recomputable.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions. Ids are written, never derived from position; never renumber.

## The policy file

1. `AC-085-01` **Given** a repo whose `.outerlayer/policy.yaml` extends the recommended registry and sets a built-in validator to `off`, **When** the evidence comment renders, **Then** that validator's row is absent entirely while the other enabled validators still render.
2. `AC-085-02` **Given** a repo with no `.outerlayer/policy.yaml`, **When** the evidence comment renders, **Then** the recommended defaults apply unchanged — the same rows as before policy existed.
3. `AC-085-03` **Given** a policy that sets a validator's level to `info`, **When** that validator flags, **Then** its row renders but the flag neither counts toward "look at N things" nor changes the verdict.

## A PR cannot loosen its own evaluation

4. `AC-085-04` **Given** a PR whose head sets a validator to `off` in the policy file, **When** that PR is evaluated, **Then** the policy is read from the PR's base branch and the validator's row still renders on this PR.

## Declarative custom validators

5. `AC-085-05` **Given** a custom validator whose `when.paths` matches the PR's diff and whose `require.session.ran` matches no classified command run, **When** it evaluates, **Then** it flags — and the row copy is its `row:` field verbatim.
6. `AC-085-06` **Given** a matching classified run for the custom's `require.session.ran` matcher, **When** it evaluates, **Then** it passes with the matched run's turn as its proof ref.
7. `AC-085-07` **Given** a custom validator whose `when.paths` matches nothing in the PR's diff, **When** the comment renders, **Then** the validator produces no row at all.
8. `AC-085-08` **Given** a `require.session.ran` matcher, **When** it is held against command runs, **Then** matching uses the same normalization as classification — wrapper prefixes and argument tails do not defeat a match, and the declared `status` must agree.

## Doctrine inherited, not re-implemented

9. `AC-085-09` **Given** a custom validator whose `needs:` fact families were not captured for the PR's sessions, **When** it evaluates, **Then** its row states it was not checkable — never a silent pass and never a false fail.

## Emitted results

10. `AC-085-10` **Given** a CI step ending in `outerlayer emit <name> --link <url>`, **When** a validator declaring that emit name evaluates, **Then** the requirement is satisfied and the row carries the CI provenance and links the run.
11. `AC-085-11` **Given** an emitted result whose name no validator declares, **When** the comment renders, **Then** the emit surfaces nothing.
12. `AC-085-12` **Given** an `outerlayer emit <name> --link <url>` invocation from CI, **When** the emit is recorded, **Then** the stored record carries the name, the result, the link, and where it came from, anchored to the PR under evaluation.

## Broken config fails loudly

13. `AC-085-13` **Given** a policy or validator file with a dangling `require.validator` id, an `emitted:` name no validator declares, or an unknown `extends:`, **When** the comment renders, **Then** a single row states the policy file has an error, naming the file and the problem — and the rest of the comment still renders.

## The rails

14. `AC-085-14` **Given** any combination of custom validator results, **When** the verdict derives, **Then** no custom validator produces the red "can't verify" verdict — user checks cap at amber.
15. `AC-085-15` **Given** a validator file with `kind: signal`, **When** the comment renders, **Then** it never renders as a validation row.

## Determinism

16. `AC-085-16` **Given** an unchanged PR under an unchanged policy, **When** the evaluation runs twice, **Then** the comment bodies are byte-identical.
