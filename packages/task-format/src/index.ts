// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export {
  TASK_SCHEMA_VERSION,
  evalTaskSchema,
  type EvalTask,
  type QuarantineEntry,
  type RunnerId,
  type TaskEnvironment,
} from "./schema.js";
export { parseTask, loadTaskFile, loadTaskDir, type LoadResult } from "./loader.js";
export { parseUnifiedDiff, type ParsedPatch } from "./diff.js";
export { lintTask, type LintResult } from "./lints.js";
export { runnerAdapter, splitTestId, type RunnerAdapter, type TestOutcome } from "./runners.js";
export {
  REPO_DIR,
  defaultMaterializeRepo,
  leakMarkers,
  taskEnvKey,
  validateTask,
  validateTasks,
  type ClarityJudge,
  type GateOptions,
} from "./gate.js";
export {
  REPORT_SCHEMA_VERSION,
  renderReportText,
  summarize,
  type InvalidReason,
  type PhaseTiming,
  type TaskDeterminism,
  type TaskReportEntry,
  type TaskStatus,
  type TaskValidationReport,
  type TestRunEvidence,
} from "./report.js";
export { recordDeterminism } from "./writeback.js";
