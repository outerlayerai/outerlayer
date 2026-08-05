import type { EmitInput, TargetBuildResult } from '../types';
import { buildAgentsMdTier } from './agents-md-tier';

/** Factory — AGENTS.md tier. `.factory/droids/` (the subagent tie-in) is not implemented here. */
export function buildFactory(input: EmitInput): TargetBuildResult {
  return buildAgentsMdTier('factory', input);
}
