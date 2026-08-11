/**
 * Conformance between the MCP tool table and its REST counterparts, plus
 * the registry invariants the dispatcher relies on (every tool declares a
 * permission).
 */

import { describe, it, expect } from 'vitest';
import {
  TopicsQuerySchema,
  TopicsListSchema,
  ListSessionsQuerySchema,
  SessionsPageSchema,
  AgentSessionDetailSchema,
  ModelStatsQuerySchema,
  FleetOverviewQuerySchema,
  FleetOverviewSchema,
  ContextChangesQuerySchema,
  ContextChangesSchema,
} from '@repo/api-schemas';
import { GATEWAY_PERMISSIONS } from '../../../lib/permissions';
import { MCP_TOOLS } from '../tools';
import { GUIDE_RESOURCE_URI } from '../resources';

const toolNames = MCP_TOOLS.map((t) => t.name);

describe('MCP_TOOLS registry invariants', () => {
  it('every tool declares a permission from the gateway permission enum', () => {
    for (const tool of MCP_TOOLS) {
      expect(GATEWAY_PERMISSIONS).toContain(tool.requiredPermission);
    }
  });

  it('tool names are unique', () => {
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });
});

// proves AC-052-06
describe('tool schemas match their REST counterparts exactly', () => {
  it('advertises exactly six tools plus the guide resource', () => {
    expect(toolNames.sort()).toEqual(
      [
        'get_fleet_overview',
        'get_model_costs',
        'get_session',
        'list_context_changes',
        'list_sessions',
        'list_topics',
      ].sort(),
    );
    expect(GUIDE_RESOURCE_URI).toBe('outerlayer://guide');
  });

  it('list_topics validates against the same Zod objects GET /v1/topics uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_topics')!;
    expect(tool.zodInputSchema).toBe(TopicsQuerySchema);
    expect(tool.zodOutputSchema).toBe(TopicsListSchema);
  });

  it('list_sessions validates against the same Zod objects GET /v1/sessions uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_sessions')!;
    expect(tool.zodInputSchema).toBe(ListSessionsQuerySchema);
    expect(tool.zodOutputSchema).toBe(SessionsPageSchema);
  });

  it('get_session validates its output against the same schema GET /v1/sessions/{traceId} uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_session')!;
    expect(tool.zodOutputSchema).toBe(AgentSessionDetailSchema);
  });

  it('get_model_costs validates its input against the same schema GET /v1/metrics/models uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_model_costs')!;
    expect(tool.zodInputSchema).toBe(ModelStatsQuerySchema);
  });

  it('get_fleet_overview validates against the same Zod objects GET /v1/metrics/overview uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_fleet_overview')!;
    expect(tool.zodInputSchema).toBe(FleetOverviewQuerySchema);
    expect(tool.zodOutputSchema).toBe(FleetOverviewSchema);
  });

  it('list_context_changes validates against the same Zod objects GET /v1/context/changes uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_context_changes')!;
    expect(tool.zodInputSchema).toBe(ContextChangesQuerySchema);
    expect(tool.zodOutputSchema).toBe(ContextChangesSchema);
  });
});
