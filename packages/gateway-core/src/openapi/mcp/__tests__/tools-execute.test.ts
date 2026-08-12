/**
 * `execute()` behavior for the MCP tools not already covered by
 * `session-tools.test.ts` (list_sessions/get_session's policy resolution)
 * or `list-topics-parity.test.ts` (list_topics' REST parity). This suite
 * pins: the `!service` ClickHouse-host-unconfigured guard shared by every
 * ClickHouse-backed tool, get_session's output-size truncation boundary,
 * and the from/to default-window wiring for get_model_costs /
 * get_fleet_overview / list_context_changes / compare_windows /
 * get_breakdown / get_trends, plus get_pr_outcomes' cost-merge behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../../routes/_shared';

const listTopics = vi.fn();
const listSessions = vi.fn();
const getSessionDetail = vi.fn();
const getGatewayTopicsService = vi.fn(() => ({ listTopics }));
const getGatewaySessionsService = vi.fn(() => ({ listSessions, getSessionDetail }));
vi.mock('../../analytics-factory', () => ({
  getGatewayTopicsService: (...args: unknown[]) => getGatewayTopicsService(...(args as [])),
  getGatewaySessionsService: (...args: unknown[]) => getGatewaySessionsService(...(args as [])),
  getGatewayChQuery: vi.fn(() => null),
}));

const getModelStats = vi.fn();
const getAgentFleetOverview = vi.fn();
const getAgentFleetMetricsBreakdown = vi.fn();
const getAgentFleetDailyTrend = vi.fn();
const getAgentPrAttribution = vi.fn();
const getAgentPrCostAttribution = vi.fn();
const getService = vi.fn(() => ({
  getModelStats,
  getAgentFleetOverview,
  getAgentFleetMetricsBreakdown,
  getAgentFleetDailyTrend,
  getAgentPrAttribution,
  getAgentPrCostAttribution,
}));
const buildTenantContext = vi.fn(() => ({ tenantId: 'tenant-1', appId: 'app-1' }));
const resolveEnvScope = vi.fn(async () => undefined);
const getScopedSupabase = vi.fn(async () => ({
  from: () => ({
    select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'prod' }, error: null }) }) }) }) }),
  }),
}));
vi.mock('../../routes/_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/_shared')>();
  return {
    ...actual,
    getService: (...args: unknown[]) => getService(...(args as [])),
    buildTenantContext: (...args: unknown[]) => buildTenantContext(...(args as [])),
    resolveEnvScope: (...args: unknown[]) => resolveEnvScope(...(args as [])),
    getScopedSupabase: (...args: unknown[]) => getScopedSupabase(...(args as [])),
  };
});

const checkBearerPermission = vi.fn(async () => false);
vi.mock('../../../lib/verify-bearer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/verify-bearer')>();
  return { ...actual, checkBearerPermission: (...args: unknown[]) => checkBearerPermission(...(args as [])) };
});

const listContextChanges = vi.fn();
vi.mock('../../routes/context', () => ({
  listContextChanges: (...args: unknown[]) => listContextChanges(...(args as [])),
}));

const compareWindows = vi.fn();
vi.mock('../../routes/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/metrics')>();
  return { ...actual, compareWindows: (...args: unknown[]) => compareWindows(...(args as [])) };
});

import { findTool, MAX_SESSION_TOOL_OUTPUT_CHARS } from '../tools';
import { daysAgo, today } from '../../routes/metrics';

function buildContext(): AppContext {
  return {
    req: { method: 'POST', path: '/v1/mcp' },
    env: { CLICKHOUSE_HOST: 'http://ch.local', OAUTH_STATE_SECRET: 'a'.repeat(32) },
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1', permissions: [] } : undefined)),
  } as unknown as AppContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  getGatewayTopicsService.mockReturnValue({ listTopics });
  getGatewaySessionsService.mockReturnValue({ listSessions, getSessionDetail });
  getService.mockReturnValue({
    getModelStats,
    getAgentFleetOverview,
    getAgentFleetMetricsBreakdown,
    getAgentFleetDailyTrend,
    getAgentPrAttribution,
    getAgentPrCostAttribution,
  });
  resolveEnvScope.mockResolvedValue(undefined);
});

describe('list_topics tool — ClickHouse host unconfigured', () => {
  it('throws ServiceUnavailableError, never calling listTopics, when no ClickHouse client resolves', async () => {
    getGatewayTopicsService.mockReturnValue(null);
    const tool = findTool('list_topics')!;
    const c = buildContext();

    await expect(tool.execute(c, { facet: 'issues', limit: 3 })).rejects.toThrow('ClickHouse host not configured');
    expect(listTopics).not.toHaveBeenCalled();
  });

  it('looks up the ClickHouse client scoped to the resolved tenant/app, and wraps the result in { data }', async () => {
    listTopics.mockResolvedValue({ topics: [{ topicId: 't1' }] });
    const tool = findTool('list_topics')!;
    const c = buildContext();

    const result = await tool.execute(c, { facet: 'issues', limit: 3 });

    expect(getGatewayTopicsService).toHaveBeenCalledWith(c.env, { tenantId: 'tenant-1', appId: 'app-1' });
    expect(result).toEqual({ data: { topics: [{ topicId: 't1' }] } });
  });
});

describe('list_sessions / get_session tools — ClickHouse host unconfigured', () => {
  it('list_sessions throws ServiceUnavailableError, never calling listSessions', async () => {
    getGatewaySessionsService.mockReturnValue(null);
    const tool = findTool('list_sessions')!;
    const c = buildContext();

    await expect(tool.execute(c, { limit: 25, offset: 0 })).rejects.toThrow('ClickHouse host not configured');
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('list_sessions looks up the ClickHouse client scoped to the caller tenant/app, and wraps the result in { data }', async () => {
    listSessions.mockResolvedValue({ sessions: [{ traceId: 't1' }], total: 1 });
    const tool = findTool('list_sessions')!;
    const c = buildContext();

    const result = await tool.execute(c, { limit: 25, offset: 0 });

    expect(getGatewaySessionsService).toHaveBeenCalledWith(c.env, { tenantId: 'tenant-1', appId: 'app-1' });
    expect(result).toEqual({ data: { sessions: [{ traceId: 't1' }], total: 1 } });
  });

  it('get_session looks up the ClickHouse client scoped to the caller tenant/app', async () => {
    getSessionDetail.mockResolvedValue(null);
    const tool = findTool('get_session')!;
    const c = buildContext();

    await tool.execute(c, { traceId: 't1' });

    expect(getGatewaySessionsService).toHaveBeenCalledWith(c.env, { tenantId: 'tenant-1', appId: 'app-1' });
  });

  it('get_session throws ServiceUnavailableError, never calling getSessionDetail', async () => {
    getGatewaySessionsService.mockReturnValue(null);
    const tool = findTool('get_session')!;
    const c = buildContext();

    await expect(tool.execute(c, { traceId: 't1' })).rejects.toThrow('ClickHouse host not configured');
    expect(getSessionDetail).not.toHaveBeenCalled();
  });
});

describe('get_session tool — output size cap', () => {
  function detailWithSpanCount(n: number) {
    return {
      session: { traceId: 't1' },
      truncated: false,
      prOutcomes: [],
      // Each span padded so the serialized body reliably crosses the 50_000
      // char cap well before span count alone would suggest.
      spans: Array.from({ length: n }, (_, i) => ({ spanId: `s${i}`, pad: 'x'.repeat(2000) })),
    };
  }

  it('returns the body as-is, with no "note" field, when serialized output is under the cap', async () => {
    getSessionDetail.mockResolvedValue(detailWithSpanCount(1));
    const tool = findTool('get_session')!;

    const result = (await tool.execute(buildContext(), { traceId: 't1' })) as { data: unknown; note?: string };

    expect(result).not.toHaveProperty('note');
    expect((result.data as { spans: unknown[] }).spans).toHaveLength(1);
  });

  it('truncates spans from the tail and adds a "note" field when serialized output exceeds the cap', async () => {
    getSessionDetail.mockResolvedValue(detailWithSpanCount(50));
    const tool = findTool('get_session')!;

    const result = (await tool.execute(buildContext(), { traceId: 't1' })) as {
      data: { spans: { spanId: string }[]; truncated: boolean };
      note: string;
    };

    expect(result.note).toContain('truncated');
    expect(result.data.truncated).toBe(true);
    // First spans kept, not last — matches the SQL-layer cap's own semantics.
    expect(result.data.spans[0]!.spanId).toBe('s0');
    expect(result.data.spans.length).toBeLessThan(50);
    expect(result.data.spans.length).toBeGreaterThan(0);
    expect(JSON.stringify({ data: result.data })).not.toMatch(/s49/);
  });

  it('returns the body unmodified, not truncated, when the serialized size lands exactly on the cap', async () => {
    const probe = { session: { traceId: 't1', pad: '' }, truncated: false, prOutcomes: [], spans: [] as unknown[] };
    const baseLen = JSON.stringify({ data: probe }).length;
    const detail = { ...probe, session: { ...probe.session, pad: 'x'.repeat(MAX_SESSION_TOOL_OUTPUT_CHARS - baseLen) } };
    expect(JSON.stringify({ data: detail }).length).toBe(MAX_SESSION_TOOL_OUTPUT_CHARS);
    getSessionDetail.mockResolvedValue(detail);
    const tool = findTool('get_session')!;

    const result = await tool.execute(buildContext(), { traceId: 't1' });

    expect(result).toEqual({ data: detail });
  });

  it('stops popping once no spans remain, even if the body is still over the cap', async () => {
    const detail = {
      session: { traceId: 't1', pad: 'x'.repeat(MAX_SESSION_TOOL_OUTPUT_CHARS) },
      truncated: false,
      prOutcomes: [],
      spans: [
        { spanId: 's0', pad: 'y'.repeat(100) },
        { spanId: 's1', pad: 'y'.repeat(100) },
      ],
    };
    getSessionDetail.mockResolvedValue(detail);
    const tool = findTool('get_session')!;

    const result = await tool.execute(buildContext(), { traceId: 't1' });

    expect(result).toEqual({
      data: { ...detail, spans: [], truncated: true },
      note: 'Output exceeded the MCP size cap and was truncated to the first spans. Fetch the full transcript via GET /v1/sessions/{traceId} over REST.',
    });
  });
});

describe('get_model_costs tool — default window', () => {
  it('defaults both from and to when neither is provided, and wraps the result in { data }', async () => {
    getModelStats.mockResolvedValue({ models: [{ model: 'gpt-5' }] });
    const tool = findTool('get_model_costs')!;

    const result = await tool.execute(buildContext(), { limit: 10 } as never);

    expect(getModelStats).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: daysAgo(7), end: today() },
      10,
      undefined,
      undefined,
    );
    expect(result).toEqual({ data: { models: [{ model: 'gpt-5' }] } });
  });

  it('uses the caller-supplied from/to instead of the defaults when both are provided', async () => {
    getModelStats.mockResolvedValue([]);
    const tool = findTool('get_model_costs')!;

    await tool.execute(buildContext(), { limit: 10, from: '2020-01-01', to: '2020-01-31' } as never);

    expect(getModelStats).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: '2020-01-01', end: '2020-01-31' },
      10,
      undefined,
      undefined,
    );
  });
});

describe('get_fleet_overview tool — default window', () => {
  it('defaults both from and to (trailing 30 days) when neither is provided, and wraps the result in { data }', async () => {
    getAgentFleetOverview.mockResolvedValue({ sessions: { current: 5, prior: 3 } });
    const tool = findTool('get_fleet_overview')!;

    const result = await tool.execute(buildContext(), {} as never);

    expect(getAgentFleetOverview).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: daysAgo(30), end: today() },
    );
    expect(result).toEqual({ data: { sessions: { current: 5, prior: 3 } } });
  });

  it('uses the caller-supplied from/to instead of the defaults when both are provided', async () => {
    getAgentFleetOverview.mockResolvedValue({});
    const tool = findTool('get_fleet_overview')!;

    await tool.execute(buildContext(), { from: '2020-02-01', to: '2020-02-28' } as never);

    expect(getAgentFleetOverview).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: '2020-02-01', end: '2020-02-28' },
    );
  });
});

describe('list_context_changes tool', () => {
  it('wraps the shared listContextChanges result in { data }', async () => {
    listContextChanges.mockResolvedValue({ changes: [{ sha: 'abc' }] });
    const tool = findTool('list_context_changes')!;
    const c = buildContext();
    const input = { limit: 10 };

    const result = await tool.execute(c, input as never);

    expect(listContextChanges).toHaveBeenCalledWith(c, input);
    expect(result).toEqual({ data: { changes: [{ sha: 'abc' }] } });
  });
});

describe('compare_windows tool', () => {
  it('wraps the shared compareWindows result in { data }', async () => {
    compareWindows.mockResolvedValue({ deltas: [] });
    const tool = findTool('compare_windows')!;
    const c = buildContext();
    const input = { a: { from: '2020-01-01', to: '2020-01-07' }, b: { from: '2020-02-01', to: '2020-02-07' } };

    const result = await tool.execute(c, input as never);

    expect(compareWindows).toHaveBeenCalledWith(c, input);
    expect(result).toEqual({ data: { deltas: [] } });
  });
});

describe('get_breakdown tool — default window', () => {
  it('defaults both from and to (trailing 30 days), passes dimension/limit through, and wraps the result in { data }', async () => {
    getAgentFleetMetricsBreakdown.mockResolvedValue({ dimension: 'branch', items: [{ key: 'main' }] });
    const tool = findTool('get_breakdown')!;

    const result = await tool.execute(buildContext(), { dimension: 'branch', limit: 10 } as never);

    expect(getAgentFleetMetricsBreakdown).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: daysAgo(30), end: today() },
      'branch',
      10,
    );
    expect(result).toEqual({ data: { dimension: 'branch', items: [{ key: 'main' }] } });
  });

  it('uses the caller-supplied from/to instead of the defaults when both are provided', async () => {
    getAgentFleetMetricsBreakdown.mockResolvedValue({ dimension: 'tool', items: [] });
    const tool = findTool('get_breakdown')!;

    await tool.execute(buildContext(), { dimension: 'tool', from: '2020-02-01', to: '2020-02-28', limit: 5 } as never);

    expect(getAgentFleetMetricsBreakdown).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: '2020-02-01', end: '2020-02-28' },
      'tool',
      5,
    );
  });
});

describe('get_trends tool — default window', () => {
  it('defaults both from and to (trailing 30 days) when neither is provided, and wraps the result in { data }', async () => {
    getAgentFleetDailyTrend.mockResolvedValue({ points: [{ date: '2026-01-01', sessions: 1 }] });
    const tool = findTool('get_trends')!;

    const result = await tool.execute(buildContext(), {} as never);

    expect(getAgentFleetDailyTrend).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { start: daysAgo(30), end: today() },
    );
    expect(result).toEqual({ data: { points: [{ date: '2026-01-01', sessions: 1 }] } });
  });
});

describe('get_pr_outcomes tool', () => {
  it('merges attribution with cost by (repo, branch, prNumber) and wraps the result in { data }', async () => {
    getAgentPrAttribution.mockResolvedValue({
      branches: ['main'],
      prNumbers: [7],
      steeredPrNumbers: [],
      items: [{ repo: 'org/app', branch: 'main', prNumber: 7, steered: false }],
    });
    getAgentPrCostAttribution.mockResolvedValue({ items: [{ repo: 'org/app', branch: 'main', prNumber: 7, costUsd: 3 }] });
    const tool = findTool('get_pr_outcomes')!;

    const result = await tool.execute(buildContext(), {} as never);

    expect(result).toEqual({
      data: {
        branches: ['main'],
        prNumbers: [7],
        steeredPrNumbers: [],
        items: [{ repo: 'org/app', branch: 'main', prNumber: 7, steered: false, costUsd: 3 }],
      },
    });
  });
});
