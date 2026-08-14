/**
 * Exact-parity test between the `list_topics` MCP tool and `GET /v1/topics`:
 * same query, same result body. Both surfaces run the same
 * `resolveTopicsScope` + `getGatewayTopicsService` code (see
 * `openapi/mcp/tools.ts`), so this pins the invariant against a regression
 * that reintroduces a second, drifting implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TopicsList } from '@repo/api-schemas';
import type { AppContext } from '../../routes/_shared';

const listTopics = vi.fn();
const getGatewayTopicsService = vi.fn(() => ({ listTopics }));
vi.mock('../../analytics-factory', () => ({
  getGatewayTopicsService: (...args: unknown[]) => getGatewayTopicsService(...(args as [])),
}));

const resolveEnvScope = vi.fn();
vi.mock('../../routes/_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/_shared')>();
  return { ...actual, resolveEnvScope: (...args: unknown[]) => resolveEnvScope(...(args as [])) };
});

import { GetTopics } from '../../routes/topics';
import { MCP_TOOLS } from '../tools';

const MOCK_ROUTE_OPTIONS = {
  router: { getRequest: () => ({}) },
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};

function buildContext(): AppContext {
  return {
    req: { method: 'GET', path: '/v1/topics' },
    env: { CLICKHOUSE_HOST: 'http://ch.local' },
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1' } : undefined)),
    json: vi.fn((body: unknown) => body),
  } as unknown as AppContext;
}

const FIXTURE: TopicsList = {
  facet: 'issues',
  mapVersion: 4,
  generatedAt: '2026-08-01T00:00:00.000Z',
  topics: [
    { topicId: 't1', name: 'Flaky CI', description: '', sessionCount: 42, share: 0.5, avgLatencyMs: 100, avgCostUsd: 1.2, errorRate: 0.1, trend: [1, 2] },
    { topicId: 't2', name: 'Auth bugs', description: '', sessionCount: 20, share: 0.24, avgLatencyMs: 90, avgCostUsd: 0.9, errorRate: 0.05, trend: [1, 1] },
    { topicId: 't3', name: 'Deploy failures', description: '', sessionCount: 12, share: 0.14, avgLatencyMs: 80, avgCostUsd: 0.5, errorRate: 0.02, trend: [0, 1] },
  ],
  noMatchCount: 9,
  samplableCount: 83,
  required: 100,
  trendDays: ['2026-08-01 00:00:00'],
  noMatchTrend: [3],
  trendBucket: 'day',
};

describe('list_topics MCP tool vs GET /v1/topics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTopics.mockResolvedValue(FIXTURE);
    resolveEnvScope.mockResolvedValue({ environment: { name: 'prod', isDefault: true } });
  });

  // proves AC-052-07
  it('returns the identical body for facet: "issues", limit: 3', async () => {
    const query = { facet: 'issues' as const, limit: 3 };

    const restContext = buildContext();
    const restRoute = new GetTopics(MOCK_ROUTE_OPTIONS) as GetTopics & { validatedData: unknown };
    restRoute.validatedData = { query };
    await restRoute.handle(restContext);
    const restBody = (restContext.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];

    const mcpContext = buildContext();
    const tool = MCP_TOOLS.find((t) => t.name === 'list_topics')!;
    const mcpBody = await tool.execute(mcpContext, query);

    expect(mcpBody).toEqual(restBody);
    expect(mcpBody).toEqual({ data: FIXTURE });
  });
});
