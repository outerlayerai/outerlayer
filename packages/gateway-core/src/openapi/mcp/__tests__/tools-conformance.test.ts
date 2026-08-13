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
  CompareWindowsQuerySchema,
  CompareWindowsSchema,
  MetricsBreakdownQuerySchema,
  MetricsBreakdownSchema,
  MetricsTrendsQuerySchema,
  MetricsTrendsSchema,
  PrOutcomesSchema,
} from '@repo/api-schemas';
import { GATEWAY_PERMISSIONS } from '../../../lib/permissions';
import type { ZodObject, ZodRawShape } from 'zod';
import { MCP_TOOLS } from '../tools';
import { toolToMcpTool } from '../dispatcher';
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

  it('never advertises a field a caller may omit (Zod default or optional) as required, for every registered tool', () => {
    for (const tool of MCP_TOOLS) {
      const mcpTool = toolToMcpTool(tool);
      const required = new Set(mcpTool.inputSchema.required ?? []);
      const shape = (tool.zodInputSchema as ZodObject<ZodRawShape>).shape;
      for (const [field, fieldSchema] of Object.entries(shape)) {
        // A field a caller may validly omit parses undefined successfully —
        // true for both `.optional()` and `.default(...)` regardless of the
        // underlying type, so this needs no per-tool knowledge of which
        // fields are defaulted.
        const callerMayOmit = fieldSchema.safeParse(undefined).success;
        if (callerMayOmit) {
          expect(required, `${tool.name}.${field} is caller-omittable but listed in required`).not.toContain(field);
        }
      }
    }
  });
});

// proves AC-052-06
describe('tool schemas match their REST counterparts exactly', () => {
  it('advertises exactly ten tools plus the guide resource', () => {
    expect(toolNames.sort()).toEqual(
      [
        'compare_windows',
        'get_breakdown',
        'get_fleet_overview',
        'get_model_costs',
        'get_pr_outcomes',
        'get_session',
        'get_trends',
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

  it('list_sessions validates output against the same Zod object GET /v1/sessions uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_sessions')!;
    expect(tool.zodOutputSchema).toBe(SessionsPageSchema);
  });

  // Deliberately NOT the same instance as REST's ListSessionsQuerySchema:
  // `pr` filtering needs a Postgres reader no MCP host has wired for list
  // reads, so this surface must not advertise a parameter it always
  // rejects (see rejectPrFilter). Every OTHER field must still match
  // exactly, so this pins the divergence to precisely `pr` and nothing else.
  it("list_sessions' input is REST's ListSessionsQuerySchema minus pr, and nothing else", () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_sessions')!;
    expect(tool.zodInputSchema).not.toBe(ListSessionsQuerySchema);

    const restShape = (ListSessionsQuerySchema as unknown as ZodObject<ZodRawShape>).shape;
    const mcpShape = (tool.zodInputSchema as ZodObject<ZodRawShape>).shape;
    expect(Object.keys(mcpShape).sort()).toEqual(Object.keys(restShape).filter((f) => f !== 'pr').sort());

    const mcpTool = toolToMcpTool(tool);
    expect(mcpTool.inputSchema.properties).not.toHaveProperty('pr');
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

  it('compare_windows validates against the same Zod objects GET /v1/metrics/compare uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'compare_windows')!;
    expect(tool.zodInputSchema).toBe(CompareWindowsQuerySchema);
    expect(tool.zodOutputSchema).toBe(CompareWindowsSchema);
  });

  it('get_breakdown validates against the same Zod objects GET /v1/metrics/breakdown uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_breakdown')!;
    expect(tool.zodInputSchema).toBe(MetricsBreakdownQuerySchema);
    expect(tool.zodOutputSchema).toBe(MetricsBreakdownSchema);
  });

  it('get_trends validates against the same Zod objects GET /v1/metrics/trends uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_trends')!;
    expect(tool.zodInputSchema).toBe(MetricsTrendsQuerySchema);
    expect(tool.zodOutputSchema).toBe(MetricsTrendsSchema);
  });

  it('get_pr_outcomes validates its output against the same schema GET /v1/prs/outcomes uses', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'get_pr_outcomes')!;
    expect(tool.zodOutputSchema).toBe(PrOutcomesSchema);
  });

  // Every tool that returns topic-map data carries the same plan gate as
  // GET /v1/topics — an ungated tool is a headless bypass of topics_enabled.
  it.each(['list_topics', 'compare_windows'])('%s is gated on topics_enabled', (name) => {
    const tool = MCP_TOOLS.find((t) => t.name === name)!;
    expect(tool.entitlement).toBe('topics_enabled');
  });
});
