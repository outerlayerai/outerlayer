// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export {
  INJECTION_CLASSES,
  type InjectionClass,
  type ModuleCandidate,
  type BugInjection,
  type SyntheticTaskMeta,
  type ModuleEnumerator,
  type InjectionModel,
} from "./types.js";
export { invertUnifiedDiff, noopTestPatch, changedLineCount } from "./diff.js";
export {
  DEFAULT_MAX_CHANGED_LINES,
  defaultIsTestPath,
  validateInjection,
  ScriptedInjectionModel,
  staticModuleEnumerator,
  type InjectionCheck,
  type InjectionRejection,
  type InjectionRejectionReason,
  type ValidateInjectionOptions,
} from "./injection.js";
export {
  generateProblemStatement,
  scrubLeaks,
  statementLeaks,
  assertNoLeak,
  type LeakTargets,
  type StatementInputs,
  type LeakSpotCheck,
} from "./statement.js";
export {
  buildSyntheticTask,
  syntheticTaskId,
  type BuildTaskContext,
  type BuiltSyntheticTask,
} from "./task.js";
export {
  calibrateDifficulty,
  DEFAULT_BAND,
  type BandThresholds,
  type CalibrationOptions,
  type CalibrationResult,
  type CalibratedTask,
  type DiscardedTask,
} from "./calibration.js";
export { dedupeSynthetic, failureSignature } from "./dedup.js";
export {
  renderProvenanceSplit,
  countByProvenance,
  SYNTHETIC_HONESTY_CAPTION,
  type ProvenanceCounts,
} from "./provenance.js";
export {
  synthesize,
  gateInversion,
  defaultValidateInversion,
  qualifiedEnv,
  DEFAULT_MAX_LOCATE_PROBABILITY,
  type SynthesizeOptions,
  type SynthesizeResult,
  type InversionResult,
  type RejectedInjection,
  type RejectionReason,
} from "./synthesize.js";
