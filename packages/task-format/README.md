# @outerlayer/task-format

The eval task format (`.outerlayer/evals/*.yaml`) and the **validation gate**:
schema, loader, static lints, and an execution gate that runs in a sandbox via
[`@outerlayer/runner-core`](../runner-core). **No task enters a report card
without passing the gate.**

Why a gate at all: execution-valid ≠ usable. 68.3% of raw SWE-bench tasks
failed human review (underspecified issues, unfair tests, flaky suites). The
gate executes the claim every task makes about itself, and flake-quarantines
what it can't trust — so cards built from these tasks basically don't flake.

## The task file

Field names deliberately mirror SWE-bench — familiarity is a feature:

```yaml
id: fix-divide-by-zero            # lowercase slug
repo: https://github.com/you/app.git
base_commit: 4f2a91c
problem_statement: >               # what a competent dev needs to ATTEMPT the
  Dividing by zero crashes the     # fix — without seeing the tests
  calculator with an unhandled
  ZeroDivisionError; it should return None.
test_patch: |                      # unified diff adding/modifying tests
  --- /dev/null
  +++ b/tests/test_divide_zero.py
  ...
gold_patch: |                      # the known-good fix (never shown to agents)
  --- a/calculator.py
  ...
fail_to_pass:                      # must FAIL before gold, PASS after
  - tests/test_divide_zero.py::test_divide_by_zero_returns_none
pass_to_pass:                      # must stay green throughout
  - tests/test_basic.py::test_subtract
environment:
  base_image: python:3.12-bookworm # pin a tag; a digest is better
  setup: pip install --quiet pytest==8.3.3
  test_cmd: python -m pytest -q
  runner: pytest                   # pytest | jest | vitest — id addressing differs
  timeout_s: 120                   # per TEST; a hung test fails the test, not the run
```

Test ids are `<file>::<name>` for every runner (pytest allows deeper `::`
nesting; jest/vitest names may contain spaces and are matched with `-t`).

Provenance fields (`statement_source`, `env_source`, `env_confidence`,
`provenance`, `quarantined`, `determinism`) are stamped by the task miner, the
env ladder in [`@outerlayer/env-prep`](../env-prep), the synthesizer in
[`@outerlayer/synth-tasks`](../synth-tasks), and this gate — see the schema in
`src/schema.ts` for the full contract.

## The gate

```ts
import { LocalDockerProvider } from "@outerlayer/runner-core";
import { loadTaskDir, validateTasks, renderReportText } from "@outerlayer/task-format";

const loaded = await loadTaskDir(".outerlayer/evals");
const tasks = loaded.flatMap((r) => (r.ok ? [r.task] : []));
const report = await validateTasks(tasks, { provider: new LocalDockerProvider() });
console.log(renderReportText(report));
```

Per task:

1. **Static lints** (no sandbox spend): `test_patch`/`gold_patch` file overlap
   ⇒ invalid (`patch_overlap`, it's a leak vector); solution symbols named in
   the statement ⇒ `needs_review` flag, never auto-reject.
2. **Environment** via `prepareEnv` — content-addressed key, so an unchanged
   task re-validates from the snapshot cache (idempotent, warm re-run <60s).
3. **Execution**, in a `network: none` sandbox (a suite that needs live
   network can't grade a trial either — that's a diagnosis, not a flake):
   apply `test_patch` → every `fail_to_pass` must **fail** → apply
   `gold_patch` → every `fail_to_pass` must **pass**, `pass_to_pass` must
   pass — repeated (default 3×); **mixed outcomes quarantine the test** with
   evidence, and grading excludes quarantined ids forever.
4. **Snapshot leak check**: a fresh sandbox from the env must contain no
   patch content — grade materials are never baked into agent-visible env
   state (the same invariant the trial harness's fresh-sandbox grading
   enforces at trial time).

Rejection taxonomy (exhaustive, first failure wins): `schema_invalid`,
`patch_overlap`, `env_fail`, `test_patch_apply_failed`, `bad_test_id`,
`f2p_pass_prefix`, `gold_apply_failed`, `gold_fails`, `p2p_fail`,
`flaky_f2p_exhausted`, `leak`. Everything lands in a versioned
`TaskValidationReport` (JSON + terminal renderer) that
[`@outerlayer/repo-report`](../repo-report) consumes as-is.

## Seams

- `envFactory` — [`@outerlayer/env-prep`](../env-prep) replaces the default
  deterministic build (clone → checkout → setup) with its
  cache/repair/escalation ladder.
- `materializeRepo` — how the repo lands in the build sandbox (tests inject
  fixtures; the default `git clone`s `task.repo`).
- `judge` — optional BYO-key LLM clarity/fairness assessor
  (SWE-bench-Verified rubric); flags `needs_review`, never rejects.

## Verifying live

```bash
OUTERLAYER_GATE_LIVE=1 yarn test:gate-live
```

Runs a seven-task matrix (the good path plus one task per failure class)
against the real local Docker daemon through `LocalDockerProvider` — one env
build, cache hits after, real pytest producing the flake quarantine, zero
leftover sandboxes.
