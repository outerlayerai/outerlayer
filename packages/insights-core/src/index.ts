// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export type {
  DetectionSession,
  DetectionTurn,
  DetectionToolCall,
  DetectionEvent,
  Finding,
  Detector,
  DetectorConfig,
  ResolvedConfig,
  Severity,
  EvidenceRef,
} from "./types.js";
export { runDetectors, rankFindings, resolveConfig, computeBaselines } from "./runner.js";
export { fromAgentSession } from "./adapt.js";
export {
  DETECTORS,
  detectorDocs,
  editRetryLoop,
  toolErrorCluster,
  costOutlier,
  apiErrorStall,
  contextChurn,
  findEditRetryRun,
  diagnoseCauses,
  type EditRetryRun,
  type OutlierCause,
} from "./detectors/index.js";
export {
  unusedSkillsFinding,
  skillNamesFromPaths,
  type UnusedSkillsInput,
} from "./detectors/unused-skills.js";
export {
  unversionedSkillsFinding,
  type UnversionedSkillsInput,
  type ActivatedSkillUse,
} from "./detectors/unversioned-skills.js";
export {
  composeDigest,
  renderDigestEmail,
  renderDigestSlack,
} from "./digest/index.js";
export type { DigestModel, DeltaStat, WeeklyRollup, DigestFinding } from "./digest/index.js";
export {
  clusterErrorSignatures,
  summarizeClusters,
  fetchAnthropicClient,
} from "./summarize/index.js";
export type { ErrorCluster, Theme, SummarizeResult, LlmClient } from "./summarize/index.js";
