# @outerlayer/env-prep

The `prepareEnv` implementation behind [`@outerlayer/runner-core`](../runner-core)'s
`SandboxProvider` seam: **deterministic build → agentic repair ladder →
escalation**, with a content-addressed snapshot cache. This is the `envFactory`
that [`@outerlayer/task-format`](../task-format)'s gate and
[`@outerlayer/trial-harness`](../trial-harness) receive — so **card runs never
build environments**.

Env setup is the empirically worst step in agent evals: automated setup succeeds
~26% pass@1 / ~63% pass@10 per repo (SWE-rebench V2). The design answer is to
build once per `(repo, commit, setup, image)` at *qualification* time, cache the
snapshot, retry agentically with a hard budget, and escalate to a human queue
instead of failing silently.

## The three outcomes

```ts
import { LocalDockerProvider } from "@outerlayer/runner-core";
import { EnvPrepService } from "@outerlayer/env-prep";

const service = new EnvPrepService({
  provider: new LocalDockerProvider(),
  repairModel,          // optional BYO-key setup-repair model (see below)
  budget: { maxAttempts: 10, maxCostUsd: 2 },
  onRepairedSetup: (task, setup) => writeTaskYaml(task), // persist provenance
});

// The envFactory seam the task gate and trial harness consume:
const env = await service.prepareEnv(task);        // throws EnvEscalatedError if unbuildable
// Warm every task at qualification time:
const report = await service.prepareEnvAll(tasks); // failure-isolated EnvBuildReport
```

1. **Deterministic** — materialize repo @ `base_commit` → run `setup` → source
   guard → health probe → the provider snapshots under the content-addressed
   key. A cache hit (index or provider) re-runs nothing.
2. **Repaired** — on a build failure, a budgeted repair model reads the error
   and proposes a *replacement setup script* (never source edits — see below).
   Each attempt is a full fresh build under the new setup's own cache key.
   Success persists the working setup back onto the task with
   `env_source: 'repaired'` so the next run is deterministic.
3. **Escalated** — the ladder exhausts its budget ⇒ a human-readable
   `EscalationItem` (last errors, attempts, cost, suggested next steps) goes to
   the sink. Never a silent skip; this queue doubles as concierge intake.

## Why "edits ONLY setup, never source" is structural

The repair model runs in the **control plane** and only ever returns a setup
string — it never gets file-editing access to the sandbox. And the build's
**source guard** (`git status --porcelain -uno` must be empty after setup)
rejects *any* setup — model- or human-written — that mutates tracked repo
source. So the guarantee holds by construction, not by trusting the model.

```ts
interface RepairModel {
  proposeSetup(ctx: RepairContext): Promise<{ setup: string; costUsd?: number }>;
}
```

Budget is HARD on attempts (a runaway repair loop is a silent COGS leak with a
trial's cost profile). The dollar ceiling is soft by one proposal: a proposal's
cost is only known after the model runs, so spend can overshoot by at most one.

## Cache key & eviction

`envCacheKey = hash(repo, base_commit, setup, base_image, image_digest?, lockfile_hashes?)`
— order-insensitive over lockfiles, every field participating (property-tested:
change any input ⇒ new key; unchanged ⇒ hit). `EnvCacheIndex` tracks build/probe
times, last use, and sizes; `evictLru(maxBytes, remove)` drops least-recently-used
unpinned entries (canary repos pin) until under budget.

## Verifying live

```bash
OUTERLAYER_ENV_PREP_LIVE=1 yarn test:env-live
```

Against the real local Docker daemon: a deterministic build, a broken-setup
fixture repaired by a scripted model (provenance persisted), an impossible
fixture escalated, and a warm boot from the snapshot measured under the 30s
acceptance bound.

## Injection points

- `repairModel` — the BYO-key Claude Code / Agent SDK repair agent.
- `materializeRepo` — how the repo lands (default `git clone`; the task miner
  and tests inject fixtures).
- `escalationSink` — cloud table + notification, or the CLI console sink.
- `index` + `sizeOf` — persistent cache index with byte-budget eviction.
