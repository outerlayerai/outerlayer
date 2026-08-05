// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export { reportStats, DEFAULT_RESAMPLES } from "./report.js";

// Standalone primitives — the repo report (pre-run MDE), the card renderer, and tests use these.
export { mde, tasksNeeded, mdeNote } from "./mde.js";
export { passAtKUnbiased, passHatKUnbiased } from "./passk.js";
export {
  wilsonInterval,
  mcnemarExactP,
  invNormCdf,
  zForAlpha,
  zForPower,
  comb,
  safeRatio,
} from "./math.js";
export { mulberry32, randInt, resampleIndices, type Rng } from "./rng.js";
export { buildPairing, majorityResolved, type PairedTask, type Pairing } from "./pairing.js";

// Simulation apparatus (deterministic) — used by the validation suite and demos.
export {
  simulateWorld,
  injectFailures,
  majorityResolveProb,
  type World,
  type WorldParams,
} from "./simulate.js";

export type {
  TrialResultLike,
  TrialStatus,
  Ratio,
  Money,
  PairedSummary,
  McNemar,
  PassAtKRow,
  Mde,
  Verdict,
  Exclusion,
  ReportStats,
  ReportStatsOptions,
  MdeParams,
} from "./types.js";
