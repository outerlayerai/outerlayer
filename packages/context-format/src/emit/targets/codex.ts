import type { EmitInput, TargetBuildResult } from '../types';
import { buildAgentsMdTier } from './agents-md-tier';

/** Codex — AGENTS.md tier. TOML mcp indirection is not implemented here. */
export function buildCodex(input: EmitInput): TargetBuildResult {
  return buildAgentsMdTier('codex', input);
}
