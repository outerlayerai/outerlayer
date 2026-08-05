# @outerlayer/eval-stats

Paired statistics for eval report cards. Given trials for **two configs** it
returns one `ReportStats` object — a paired resolve-rate delta with a confidence
interval, the minimum effect this run could even detect (MDE), cost/effort
deltas, pass@k, and a **tiered verdict that never declares a naked winner.**

Small task sets cannot detect small differences. Roughly **150–250 paired tasks**
are needed to resolve a 10pp gap, **~80–120** for 15pp, and **≤5pp is effectively
unresolvable** (paired designs are ~2× more efficient than unpaired). So the
product must *say what it can and cannot detect*: the MDE is printed on every
card, verdicts are tiered, and every number a card shows comes from here — the UI
never computes statistics.

This package is **pure, deterministic, seeded, and has zero runtime
dependencies** (all four are enforced by tests). No I/O, no `Date.now()`, no
`Math.random()`: all randomness is a seeded RNG ([mulberry32](./src/rng.ts)) whose
seed is a function parameter, so **the same input and seed produce byte-identical
output** (pinned by a committed golden).

```ts
import { reportStats } from "@outerlayer/eval-stats";

const stats = reportStats(trials, { configA: "gpt-5", configB: "claude", seed: 1 });
console.log(stats.verdict, "—", stats.verdictRules);
// underpowered — 95% CI [-4.2, 11.8] pp includes 0. Observed Δ=3.8 pp needs
// ~412 paired tasks to detect at 80% power (have 60); more trials/task also
// help if the 27% discordance is noise-driven.
```

## Input: `TrialResultLike`

The package is standalone by design — it does **not** import the trial
harness's `TrialResult`. It consumes a minimal local shape so it can develop and
be golden-tested against synthetic fixtures independently; the harness's richer
result is structurally assignable to it.

```ts
interface TrialResultLike {
  taskId: string;
  config: string;          // one of the two being compared
  resolved: boolean;       // did this trial resolve the task?
  costUsd: number;
  turns: number;
  wallClockMs: number;
  tokens: number;
  status: "graded" | "infra_failed" | "quarantined";
}
```

**Only `status: "graded"` trials count.** `infra_failed` (harness/runner fault,
not the agent's) and `quarantined` (flaky gate test) are dropped before anything
is computed, and can lead to a task being excluded (below).

## The contract

```ts
interface ReportStats {
  configs: [string, string];        // [A, B] — the delta-sign order
  nTasks: number;                   // paired tasks after exclusions
  trialsPerTask: number;            // fully-supported trials/task

  resolveRate: { a: Ratio; b: Ratio };            // task-level, Wilson CIs

  pairedDelta: {                    // PRIMARY metric
    est: number;                    // resolveRate.a − resolveRate.b
    ci95: [number, number];         // paired bootstrap (≥10k resamples, seeded)
    mcnemar: { b: number; c: number; p: number };  // exact, on discordant tasks
  };

  dollarsPerResolved: { a: Money; b: Money; ci95Ratio: [number, number] };
  efficiency: { turns: PairedSummary; wallClock: PairedSummary; tokens: PairedSummary };
  passAtK: { k: number; a: number; b: number }[];  // unbiased pass@k
  passHatK: { k: number; a: number; b: number }[]; // unbiased pass^k (see note)

  mde: { at80Power: number; note: string };

  verdict: "clear" | "directional" | "underpowered";
  verdictRules: string;             // the exact rule that fired, in words

  exclusions: { taskId: string; reason: string }[];
  sensitivity: {
    excludedFlippedConclusion: boolean;
    perTrialDelta: { est: number; ci95: [number, number] };  // see note
  };
}
```

**Sign convention.** Every delta is **`A − B`** where `configs = [A, B]`. A
positive `pairedDelta.est` means A resolves more tasks than B. Efficiency deltas
are also `A − B` (positive turns/cost/tokens = A spent *more*).

**Multiple-comparisons discipline.** The card headlines exactly one primary
metric — the **paired resolve-rate delta**. `dollarsPerResolved` and `efficiency`
are secondary; `passAtK`/`passHatK` are exploratory. The verdict is derived from
the primary metric only.

> **`passHatK` and `sensitivity.perTrialDelta` are additive extras.** `passHatK`
> is `pass^k` — the all-k-trials-succeed counterpart to `pass@k`'s
> at-least-one. `sensitivity.perTrialDelta` recomputes the delta with per-trial
> rather than per-task pairing, as a robustness check on the primary metric.
> Both are optional for a consumer to read.

## Pairing

- **The unit of analysis is the task.** For each task and config we take the
  **strict majority** outcome over that config's graded trials (`2·resolved >
  trials`; an even split is *not* a resolve), then pair the two configs
  task-by-task. The paired point estimate `mean(majA − majB)` equals the
  marginal difference `rate(A) − rate(B)`.
- **Exclusions.** A task with no graded trials for one config — because trials
  were missing (asymmetric) or all infra-failed/quarantined — cannot be paired
  and is dropped into `exclusions[]` with a reason. It does not enter `nTasks`.
- **`trialsPerTask`** is the largest `k` supported by *every* included task for
  *both* configs (so pass@k rows are fully comparable).

## The statistics

### Wilson score intervals (`resolveRate`)

Task-level resolve rate per config with a Wilson score 95% CI — robust near 0
and 1 where the naive Wald interval fails, and clamped to `[0, 1]`. `n = 0`
returns the no-information interval `[0, 1]`.

### Paired bootstrap (`pairedDelta.ci95`, and every other bootstrap CI)

One **coherent** bootstrap: each replicate resamples *tasks* with replacement and
recomputes the delta, the cost ratio, the three effort deltas, and the per-trial
delta from the **same** resample, so the intervals are mutually consistent and
fully seed-determined. The CI is the 2.5/97.5 percentile (type-7 interpolation).
**Production default: 10,000 resamples** (`DEFAULT_RESAMPLES`, asserted `≥ 10000`).

### Exact McNemar (`pairedDelta.mcnemar`)

The paired test operates on discordant task-majorities: `b` = tasks A resolved
but B did not, `c` = the reverse. Under H₀ each discordant pair is a fair coin,
so the count on one side is `Binomial(b + c, ½)`; we sum the **two-sided exact
tail** with an overflow-safe iterative PMF (it never forms `C(200,100)`
directly). No discordance ⇒ `p = 1`. Small-sample-safe by construction.

### Minimum Detectable Effect (`mde`, and standalone `mde()`)

Closed-form McNemar power approximation. With discordance rate `p_d` on `n` pairs,
the per-task signed outcome has variance `p_d` under H₀, so

```
MDE = (z_{α/2} + z_β) · sqrt(p_d / n)
```

decreasing in `n`, increasing in `p_d`. It reproduces the headline figures: a
10pp gap needs **157–235** pairs at `p_d ∈ [0.2, 0.3]`; 15pp needs **70–105**
(see `tasksNeeded()`, the inverse used for the `underpowered` prescription). The
function is parameterized **purely by `(n, p_d)`**, so the Repo Report can call
it *pre-run* with an assumed discordance in `[0.2, 0.3]` and a stated-assumption
note; the report calls it with the *observed* discordance.

> **MDE and the role of `k`.** Extra trials per task enter only through their
> effect on the observed discordance: more trials denoise the per-task majority
> label, lowering discordance **when disagreement is noise-driven**, which lowers
> the MDE (the simulation suite verifies this end-to-end). When discordance is
> instead *systematic* (tasks whose true resolvability straddles ½), more trials
> sharpen the signal into `b − c` rather than shrinking `b + c` — the McNemar
> point estimate gains power that this discordance-only MDE does not credit. We
> report the conservative discordance-based MDE deliberately; it is a floor on
> what we claim to detect, not a ceiling on what the test can find.

### `$ / resolved-task` (`dollarsPerResolved`)

Per config: **total measured cost over all graded trials ÷ tasks resolved by
majority.** Division by zero is guarded: **0 resolves ⇒ `Infinity`, never `NaN`.**
Renderers must show `Infinity` as "n/a (0 resolved)". The A/B ratio CI is
bootstrapped in cross-multiplied form so a `0/0` resample is defined (⇒ `1`, "no
evidence of a difference") rather than `NaN`.

### pass@k / pass^k (`passAtK`, `passHatK`)

Unbiased combinatorial estimators over a task's trials, averaged across tasks —
the Codex/HumanEval form, exact expectations of drawing `k` of `n` trials
*without* replacement, not the biased "did any of the first k pass" plug-in:

```
pass@k = 1 − C(n−c, k) / C(n, k)      (at least one of k succeeds)
pass^k =     C(c,   k) / C(n, k)      (all k succeed — a consistency metric)
```

## Verdict rules (versioned, documented)

The verdict is computed from the primary metric only. `verdictRules` states the
exact rule that fired, with numbers, so a card is self-explaining.

**`clear`** — the 95% CI excludes 0 **and** `|est| ≥ 0.8 · MDE`.
Both conditions are required: the CI rules out "no difference", and the effect
clears our own detectability bar so we are not over-claiming at the edge of what
this N can see.

**`directional`** — the CI *includes* 0, **but** the sign is consistent across
**≥ 70%** of discordant tasks **and** pass@1 agrees with pass@k in direction.
A suggestive lean that is not yet conclusive: the interval still spans 0, yet the
task-by-task signal and the trial-granularity signal both point the same way.

**`underpowered`** — anything else, **always with a prescription**: the number of
paired tasks needed to bring the MDE down to the observed `|est|` at 80% power
(via `tasksNeeded()`), plus the note that more trials/task help when discordance
is noise-driven. Three sub-cases, each rendered accurately:

| Situation | Why not `clear`/`directional` | Message |
|---|---|---|
| CI includes 0, signal inconsistent | fails both tiers | "…includes 0. Observed Δ=… needs ~N paired tasks…" |
| CI **excludes** 0 but `|est| < 0.8·MDE` | not `clear` (below bar); not `directional` (CI excludes 0) | "…excludes 0 but \|Δ\| < 0.8·MDE; interval too wide to trust at this N…" |
| Δ ≈ 0 | no effect to size | "Δ≈0 …; no effect to size. MDE at this N is …" |

### Sensitivity

- **`excludedFlippedConclusion`** — always computed. The whole analysis is re-run
  *including* the excluded tasks (each missing side imputed as an unresolved,
  zero-effort trial); `true` iff that flips the verdict.
- **`perTrialDelta`** — the delta at pass@1 (per-trial) granularity, as an
  alternative to majority-over-trials. If it disagrees with `pairedDelta`, the
  majority collapse is doing something and the result deserves a second look.

## Determinism & the golden

Every output number is rounded to 10 decimals (McNemar `p` excepted — it is left
full-precision so tiny-but-nonzero p-values are never flattened to 0). A
committed golden (`src/__tests__/golden.test.ts`) pins the entire object via
`toEqual`; a change there is a change to a public claim surface. **Permutation
invariance** is a property test: swapping config order negates every delta and
swaps every per-config field exactly, while the verdict, magnitude, and MDE are
unchanged.

## Simulation validation (the acceptance suite)

`src/__tests__/simulation.test.ts` generates synthetic worlds with **known true
deltas** {0, 5, 10, 20 pp} × **N** {30, 80, 200} × **k** {1, 3} from the seeded
RNG and asserts the machine's honesty:

- **Coverage** — the paired 95% CI covers the true majority delta; pooled
  coverage lands in **[0.93, 0.97]** (≈95%).
- **Verdict behaviour** — true **10pp at N=30** is *rarely* `clear` (<15%); true
  **20pp at N=200** is *mostly* `clear` (>60%, at k=1 and k=3); true **0pp** is
  essentially never `clear`.
- **Monotonicity** — the MDE decreases in **N** (closed-form and end-to-end) and
  in **k** (end-to-end, noise-dominated world).

Sim and resample counts inside the suite are modest so it runs in a few seconds;
the production default stays ≥ 10k (asserted separately). The suite — not the
back-of-envelope power figures above — is the ground truth; recalibrate the MDE
note text from it.

## Standalone API

Beyond `reportStats`, the primitives are exported for
[`@outerlayer/repo-report`](../repo-report) (pre-run MDE),
[`@outerlayer/report-card`](../report-card) (rendering), and reuse:

```ts
mde({ nPairs, discordanceRate, power?, alpha? }): number
tasksNeeded(targetDelta, { discordanceRate, power?, alpha? }): number
mdeNote({ nPairs, discordanceRate, assumption, ... }): string
wilsonInterval(successes, n, alpha?): { value, ci95 }
mcnemarExactP(b, c): number
passAtKUnbiased(c, n, k): number
passHatKUnbiased(c, n, k): number
invNormCdf(p) / zForAlpha(alpha) / zForPower(power): number
mulberry32(seed): () => number
simulateWorld(params): World          // seeded synthetic world + exact ground truth
```

## License

Apache-2.0 · Copyright 2026 Magu Studios, Inc.
