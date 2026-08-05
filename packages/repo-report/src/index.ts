// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export { classifyStack, type StackDetection, type StackSupport, type StackVerdict } from "./matrix.js";
export {
  REPO_REPORT_SCHEMA_VERSION,
  buildRepoReport,
  type Banner,
  type CostEstimate,
  type EnvSummary,
  type MiningFunnel,
  type PowerRow,
  type RepoReport,
  type RepoReportInputs,
  type ValidationSummary,
} from "./report.js";
export { renderReportHtml, renderReportText } from "./render.js";
