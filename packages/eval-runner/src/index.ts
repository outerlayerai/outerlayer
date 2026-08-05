// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export {
  composeReportCard,
  runEvaluation,
  type ComposeCardOptions,
  type ComposedCard,
  type EvalRunOptions,
  type EvalRunResult,
} from "./runner.js";
export {
  buildDivergent,
  buildPerTask,
  buildTaxonomy,
  toCardStats,
  toStatsTrials,
  totalCost,
} from "./map.js";
export {
  envEscalationAlert,
  envEscalationRow,
  persistingEscalationSink,
  type EnvEscalationRow,
  type EscalationContext,
} from "./escalation-bridge.js";
export {
  chunkTrials,
  evalTrialSessionId,
  persistTrialResults,
  persistTrialSessions,
  CHUNK_BYTES,
  SESSIONS_PER_SYNC,
  TRIALS_PER_REQUEST,
  type PersistTrialsOptions,
  type PersistTrialsReport,
} from "./persist.js";
export {
  buildTrialSession,
  buildTrialSessions,
  type BuildTrialSessionsOptions,
  type TrialTranscript,
} from "./sessions.js";
export {
  EvalGatewayClient,
  EvalGatewayError,
  type EvalGatewayClientOptions,
  type EvalRunJob,
} from "./gateway-client.js";
// Re-exported so consumers of the composition seam (the CLI's `eval report`)
// type against the same TrialResult the runner produces.
export type { TrialResult } from "@outerlayer/trial-harness";
