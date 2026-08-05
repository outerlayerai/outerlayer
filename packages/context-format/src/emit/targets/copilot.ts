import type { EmitInput, TargetBuildResult } from '../types';
import { buildAgentsMdTier } from './agents-md-tier';

/** Copilot — AGENTS.md tier. */
export function buildCopilot(input: EmitInput): TargetBuildResult {
  return buildAgentsMdTier('copilot', input);
}
