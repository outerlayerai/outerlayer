# @outerlayer/trial-harness

The heart of the runner: execute one `(task × config × trial)` — run the agent
against the pre-fix repo, freeze its patch, grade by executing the repo's
tests. Built on [`@outerlayer/runner-core`](../runner-core) and
[`@outerlayer/task-format`](../task-format), fed by
[`@outerlayer/env-prep`](../env-prep).

Two invariants ARE the product's credibility:

1. **The agent never sees `test_patch`/`gold_patch`.** Grade materials are
   applied only in the grade sandbox, never the agent's — enforced by leak
   assertions, not convention.
2. **Agent failures are results, never retried.** Only `infra_error` retries
   (max 2). `agent_error`, `timeout`, `patch_apply_failed`, `build_error` are
   all *results* — retrying them would launder a real signal.

## Fresh-sandbox grading

Grading runs in a **fresh sandbox booted from the same `EnvRef`**, never the
agent's sandbox. `git reset --hard` cannot undo
what an agent did to *untracked* state — a trojaned `pytest`/`node` shim on
PATH, a poisoned `node_modules`, a daemon waiting for the test patch to land —
and a reward-hacking agent has every incentive to game the grade. The harness:

```
agent sandbox (network:default)          grade sandbox (network:none, FRESH)
  inject context + auth (per-exec)          apply frozen candidate patch
  assert clean worktree                     apply test_patch  ← only ever here
  run agent under budgets                   run fail_to_pass + pass_to_pass
  freeze patch OUT, checksum it             → graded / resolved
  pull transcript → destroy
```

This is proven live: `OUTERLAYER_TRIAL_LIVE=1 yarn test:trial-live` runs an
adversarial agent that trojans the test runner (a PATH shim that always exits
0) and writes a *wrong* fix. A same-sandbox grade would score it **resolved**
(the fixture asserts the trojan flips it); fresh-sandbox grading grades the
real, failing verdict — `resolved: false`.

## Multi-agent launcher seam

The agent CLI is a config choice, never hardcoded — `claude-code` and `codex`
ship in v1, others register behind the same interface:

```ts
interface AgentLauncher {
  id: string;
  invoke(ctx): { command; env; transcriptPath };  // headless CLI + per-exec auth
  parseTranscript(raw): TrajectorySummary;         // fields it can't provide → null
}
```

Auth is API keys only (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / vendor keys via
`base_url`), injected per-exec, never in create-time config or logs. A
launcher whose transcript lacks a metric degrades it to `null` — it never
blocks grading.

## Result contract

`TrialResult` (versioned): status taxonomy (`graded | agent_error |
patch_apply_failed | build_error | timeout | infra_error`), `resolved`,
per-test `failToPass`/`passToPass`, the frozen `patch`, `trajectory` summary,
`cost` (`measured` from usage × prices, else `estimated`), the five `leak`
assertions, and provenance carried from the task. `runMatrix` fans out over
task × config × trial with a concurrency pool, the infra-only retry policy,
and a budget kill-switch (measured spend ≥ `maxUsd` ⇒ no new trials start).

## Verifying

```bash
yarn vitest run                    # unit: phase ordering, retry policy, leak, cost, launcher parsing
OUTERLAYER_TRIAL_LIVE=1 yarn test:trial-live   # the grade-integrity proof vs real Docker
```
