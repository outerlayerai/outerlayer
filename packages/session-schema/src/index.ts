// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export {
  SCHEMA_VERSION,
  EVENT_TYPES,
  WORKER_KINDS,
  AgentSessionSchema,
  TurnSchema,
  ToolCallSchema,
  UsageSchema,
  SessionEventSchema,
  ParseWarningSchema,
  parseAgentSession,
  safeParseAgentSession,
  isHumanUserTurn,
  _tierPathsUsedBySchema,
} from "./schema.js";
export type {
  AgentSession,
  WorkerKind,
  Turn,
  ToolCall,
  Usage,
  SessionEvent,
  ParseWarning,
  WellKnownEventType,
} from "./schema.js";
export {
  CAPTURE_TIERS,
  FIELD_TIERS,
  tierAtLeast,
  contentBearingPaths,
  bannedPathsForTier,
  downconvertSession,
  tierViolations,
} from "./tiers.js";
export type { CaptureTier } from "./tiers.js";
export { canonicalStringify } from "./canonical.js";
export { agentSessionJsonSchema, AGENT_SESSION_SCHEMA_ID } from "./json-schema.js";
export {
  spanTreeFromSession,
  agentSessionToTraceSession,
  agentSessionToTrace,
  dominantModel,
} from "./trace.js";
export type {
  SpanData,
  TraceData,
  TraceSession,
  TraceTurn,
  TraceToolCall,
  AgentSessionTree,
} from "./trace.js";
