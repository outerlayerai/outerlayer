# @outerlayer/synth-tasks

Synthetic task augmentation — **grow the N** so an underpowered card reaches a
tighter MDE. Most repos mine tens of tasks; detecting a 10pp difference wants
150–250. Following SWE-smith, this package synthesizes *validated* tasks from a
repo's **passing** state, each clearly `provenance: 'synthetic'` and **never
silently mixed** with mined tasks.

## The inversion (the key insight)

We do not mine bugs from history. We take the repo's PASSING state (the
qualified env from [`@outerlayer/env-prep`](../env-prep)) and **inject** a
semantic bug that breaks EXISTING, already-green tests. That inverts every role
[`@outerlayer/task-format`](../task-format)'s gate expects:

| Role | Mined from history | Synthesized here |
|---|---|---|
| `base_commit` | the historical buggy commit | the **injected** (broken) throwaway ref |
| `gold_patch` | the human's fix | the **revert** of the injection |
| `fail_to_pass` | tests added by `test_patch` | **pre-existing** tests the injection breaks |
| `pass_to_pass` | unrelated tests | unrelated **pre-existing** tests |
| `test_patch` | the diff that adds the failing tests | a **no-op sentinel** (tests already exist) |

The injection model proposes bounded, in-place bugs per function — off-by-one,
inverted condition, dropped await, boundary regression — and is **structurally
forbidden from editing test files** (`validateInjection` rejects any injection
whose diff touches a test path, creates/deletes a file, exceeds the diff
budget, or breaks no test). So the "gold_patch = revert" story can never turn
into a grade-material leak.

### `test_patch` ↔ validation-gate mapping

The [`@outerlayer/task-format`](../task-format) gate runs: apply `test_patch` →
every `fail_to_pass` **fails** → apply `gold_patch` → `fail_to_pass` **passes**,
`pass_to_pass` **passes** → snapshot leak check. For a synthetic task the
failing tests **already exist at `base_commit`** and fail there because the bug
is present, so conceptually the `test_patch` should be *empty*.

The one gate assumption this leans on: **`test_patch` must be a non-empty,
parseable unified diff** (`unifiedDiff()` + `parseUnifiedDiff` require a file
header and a hunk), so a *literally* empty `test_patch` is not expressible. The
honest, minimal stand-in is a **sentinel no-op** (`noopTestPatch`): a new-file
diff for one throwaway marker (`.outerlayer/synthetic/<id>.noop`) whose content
is kept under the gate's 12-char leak-marker floor. It:

- satisfies the schema (non-empty, parseable);
- touches **no** test and **no** source, so it never overlaps `gold_patch`
  (no `patch_overlap`) and changes **no** test outcome — the pre-gold phase
  still sees `fail_to_pass` fail;
- carries no distinctive content into the env snapshot (leak check stays green).

Result: **every synthetic task passes gate validation untouched** — proven
hermetically in `src/__tests__/gate.test.ts`, which drives task-format's real
`validateTask` over a synthesized task.

## Usage

```ts
import { synthesize, renderProvenanceSplit, SYNTHETIC_HONESTY_CAPTION } from "@outerlayer/synth-tasks";

const { tasks, meta, rejected, discardedByBand } = await synthesize({
  repo,
  env,                 // qualified env for the PASSING state (from @outerlayer/env-prep)
  provider,            // @outerlayer/runner-core SandboxProvider
  environment,         // the repo's env block (base_image / test_cmd / runner …)
  enumerator,          // ModuleEnumerator: well-tested + fast modules
  injectionModel,      // BYO-key LLM proposing bounded semantic bugs
  commitInjection,     // apply injection to a throwaway ref → base_commit
  resolveRateOf,       // reference-config resolve rate per task (calibration)
  generatorVersion: "synth-0.1.0",
});

console.log(renderProvenanceSplit({ mined: 84, synthetic: tasks.length }));
// → "N=84 mined + 120 synthetic"     (SYNTHETIC_HONESTY_CAPTION captions the set)
```

The pipeline (all infra behind injectable seams, so it runs hermetically):

1. **Candidate generation** — `ModuleEnumerator` yields well-tested, fast
   modules in the qualified env.
2. **Injection + inversion** — `InjectionModel` proposes bugs;
   `validateInjection` rejects test-touchers/oversized/no-target diffs;
   `buildSyntheticTask` assembles the inverted `EvalTask`.
3. **Problem statement** — `generateProblemStatement` writes a bug report from
   the symptom + failing-test output and **leak-scrubs** the injected function
   name, file path, and basename verbatim. A `LeakSpotCheck` seam lets a judge
   veto any statement from which the bug is still locatable.
4. **Validation inversion** — the task-format gate mechanics with inverted roles
   (`gateInversion`/`defaultValidateInversion`): `fail_to_pass` must fail at the
   injected base and pass after the revert; `pass_to_pass` stays green.
5. **Difficulty calibration** — `calibrateDifficulty` runs a reference config
   (the `resolveRateOf` seam) and **discards** tasks resolved <5% (too hard) or
   >95% (too easy); survivors are flagged for the 30–80% target band.
6. **Dedup** — injections that break the same failing tests collapse to one
   task (same `failureSignature`).

## Provenance rules (do not merge)

- Every task is stamped `provenance: 'synthetic'`. Extra audit metadata
  (generator version, injection class, symptom, calibrated resolve rate) rides
  in a **side** `SyntheticTaskMeta` — the shared `EvalTask` schema is never
  mutated and no new required fields are invented.
- The reporting layers surface the natural-vs-synthetic split;
  `renderProvenanceSplit` exists so `mined + synthetic` can **never** be
  rendered as one merged headline.
- **Honesty caption:** synthetic tasks measure *bug-fixing on your codebase*,
  not feature work. A card must caption them as
  **"regression-fix tasks, not feature work"** (`SYNTHETIC_HONESTY_CAPTION`).

## Gotchas

- Injected states live on **throwaway refs/worktrees only** (never real
  branches) and are GC'd — `commitInjection` owns that lifecycle.
- The injection agent is budget-capped like the env-prep repair agent; emit cost
  telemetry from the `InjectionModel` implementation.
- A statement that names the fix is a fill-in-the-blank, not a bug report —
  keep the `LeakSpotCheck` seam wired in production.
