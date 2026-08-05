// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export { envCacheKey, envKeyForTask, type EnvKeyInputs } from "./key.js";
export {
  buildTaskEnv,
  cloneMaterializer,
  EnvBuildError,
  type BuildEnvOptions,
  type BuildResult,
  type BuildStage,
  type MaterializeRepo,
} from "./build.js";
export {
  buildWithRepairLadder,
  DEFAULT_REPAIR_BUDGET,
  type LadderOptions,
  type LadderResult,
  type RepairBudget,
  type RepairContext,
  type RepairModel,
  type RepairProposal,
} from "./repair.js";
export {
  consoleEscalationSink,
  collectEscalationSink,
  type EscalationItem,
  type EscalationSink,
} from "./escalation.js";
export { EnvCacheIndex, type CacheIndexEntry } from "./cache-index.js";
export {
  EnvEscalatedError,
  EnvPrepService,
  type EnvPrepOptions,
} from "./prepare.js";
export {
  ENV_REPORT_SCHEMA_VERSION,
  renderEnvReportText,
  summarizeEnvResults,
  type EnvBuildReport,
  type EnvOutcome,
  type EnvTaskResult,
} from "./report.js";
