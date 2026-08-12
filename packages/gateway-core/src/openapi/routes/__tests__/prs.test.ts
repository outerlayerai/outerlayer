/**
 * Route-level tests for GET /v1/prs/outcomes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../_shared';

const getAgentPrAttribution = vi.fn();
const getAgentPrCostAttribution = vi.fn();
const getService = vi.fn(() => ({ getAgentPrAttribution, getAgentPrCostAttribution }));
vi.mock('../_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_shared')>();
  return {
    ...actual,
    getService: (...args: unknown[]) => getService(...(args as [])),
  };
});

import { GetPrOutcomes } from '../prs';

const MOCK_ROUTE_OPTIONS = {
  router: { getRequest: () => ({}) },
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};

function buildContext(): AppContext {
  return {
    req: { method: 'GET', path: '/v1/prs/outcomes' },
    env: {},
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1' } : undefined)),
    json: vi.fn((body: unknown) => body),
  } as unknown as AppContext;
}

function buildRoute(): GetPrOutcomes {
  return new GetPrOutcomes(MOCK_ROUTE_OPTIONS);
}

describe('GetPrOutcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // proves AC-052-17
  it('merges attribution items with cost by (repo, branch, prNumber), defaulting a missing group to costUsd: 0', async () => {
    getAgentPrAttribution.mockResolvedValue({
      branches: ['main', 'feature/x'],
      prNumbers: [42, 43],
      steeredPrNumbers: [43],
      items: [
        { repo: 'org/app', branch: 'main', prNumber: 42, steered: false },
        { repo: 'org/app', branch: 'feature/x', prNumber: 43, steered: true },
      ],
    });
    getAgentPrCostAttribution.mockResolvedValue({
      items: [{ repo: 'org/app', branch: 'main', prNumber: 42, costUsd: 7.25 }],
    });

    const route = buildRoute();
    const c = buildContext();
    await route.handle(c);

    expect(c.json).toHaveBeenCalledWith({
      data: {
        branches: ['main', 'feature/x'],
        prNumbers: [42, 43],
        steeredPrNumbers: [43],
        items: [
          { repo: 'org/app', branch: 'main', prNumber: 42, steered: false, costUsd: 7.25 },
          // No cost row for (org/app, feature/x, 43) — defaults to 0, not undefined.
          { repo: 'org/app', branch: 'feature/x', prNumber: 43, steered: true, costUsd: 0 },
        ],
      },
    });
  });

  it('does not date-window either underlying read', async () => {
    getAgentPrAttribution.mockResolvedValue({ branches: [], prNumbers: [], steeredPrNumbers: [], items: [] });
    getAgentPrCostAttribution.mockResolvedValue({ items: [] });

    const route = buildRoute();
    const c = buildContext();
    await route.handle(c);

    expect(getAgentPrAttribution).toHaveBeenCalledWith({
      userId: '',
      tenantId: 'tenant-1',
      appId: 'app-1',
      dataRetentionDays: -1,
    });
    expect(getAgentPrCostAttribution).toHaveBeenCalledWith({
      userId: '',
      tenantId: 'tenant-1',
      appId: 'app-1',
      dataRetentionDays: -1,
    });
  });

  it('returns a mapped 5xx when a read fails', async () => {
    getAgentPrAttribution.mockRejectedValue(new Error('boom'));
    getAgentPrCostAttribution.mockResolvedValue({ items: [] });

    const route = buildRoute();
    const c = buildContext();
    await route.handle(c);

    const [, status] = c.json.mock.calls[0]! as [unknown, number];
    expect(status).toBeGreaterThanOrEqual(500);
  });
});
