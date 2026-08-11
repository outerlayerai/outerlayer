// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export { parseTranscript, normalizeErrorSignature } from "./adapters/claude-code/parse.js";
export type { ParseOptions, ParseResult, CapturedBlob } from "./adapters/claude-code/parse.js";
export {
  resolvePrice,
  costOfUsage,
  isPriceKnown,
  PRICE_TABLE_SOURCE,
} from "./pricing.js";
export type { ModelPrice, PriceResolution } from "./pricing.js";
export { tailTranscript, completePrefix } from "./tailer.js";
export type { Checkpoint, TailResult } from "./tailer.js";
export { scanAll } from "./scan.js";
export type { ScanOptions, ScanReport } from "./scan.js";
export {
  findTranscripts,
  sessionIdFromPath,
  defaultProjectsDir,
  defaultRawDir,
} from "./adapters/claude-code/discover.js";
export type { TranscriptEntry } from "./adapters/claude-code/discover.js";
export {
  SOURCE_ADAPTERS,
  claudeCodeAdapter,
  codexAdapter,
  parseCodexRollout,
  findCodexRollouts,
  codexSessionIdFromPath,
  defaultCodexSessionsDir,
  cursorAdapter,
  parseCursorChat,
  findCursorChats,
  cursorChatIdFromPath,
  workspacesByHash,
  defaultCursorChatsDir,
  defaultCursorProjectsDir,
  rootChildIds,
} from "./adapters/index.js";
export type { SourceAdapter, SourceRoots, SourceParseOptions } from "./adapters/types.js";
export { CaptureDaemon } from "./daemon.js";
export type { DaemonOptions, DaemonLogEvent } from "./daemon.js";
export {
  StatuslineAggregator,
  computeStatuslineState,
  readStatuslineState,
  writeStatuslineState,
  readSyncWatermarkMs,
  statuslineStatePath,
} from "./statusline-state.js";
export type { StatuslineState, StatuslineAggregatorOptions, ComputeStatuslineOptions } from "./statusline-state.js";
export { WARNING_CODES } from "./warnings.js";
export type { WarningCode } from "./warnings.js";
export { SUPPORTED_VERSIONS, compareVersions, isNewerThanSupported } from "./versions.js";

export { resolveRepoIdentity, enrichSessionRepo, normalizeRemote } from "./repo-identity.js";
export { scrubText, scrubDeep, SECRET_PATTERNS, setLocalIdentity, setCustomScrubbers, setRepoRoot, type LocalIdentity, type CustomScrubConfig } from "./scrub-secrets.js";
export type { RepoIdentity } from "./repo-identity.js";
