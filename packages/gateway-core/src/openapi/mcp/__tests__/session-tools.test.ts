/**
 * `list_sessions` / `get_session` MCP tool execute() tests.
 *
 * These tools share `sessionPolicy`/`buildPorts` with the REST routes
 * (`../routes/sessions`), so the actor-privacy contract is proven once
 * there (`routes/__tests__/sessions.test.ts`). This suite pins the one
 * thing specific to the MCP path: `execute()` awaits the async
 * `sessionPolicy` before calling the service, so a bearer caller's policy
 * resolution actually completes before the ClickHouse query runs rather
 * than a pending Promise being forwarded as the policy argument.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../../routes/_shared';

const listSessions = vi.fn();
const getSessionDetail = vi.fn();
const getGatewaySessionsService = vi.fn(() => ({ listSessions, getSessionDetail }));
const getGatewayChQuery = vi.fn(() => null);
vi.mock('../../analytics-factory', () => ({
  getGatewaySessionsService: (...args: unknown[]) => getGatewaySessionsService(...(args as [])),
  getGatewayChQuery: (...args: unknown[]) => getGatewayChQuery(...(args as [])),
}));

const getScopedSupabase = vi.fn();
vi.mock('../../routes/_shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/_shared')>();
  return {
    ...actual,
    getScopedSupabase: (...args: unknown[]) => getScopedSupabase(...(args as [])),
  };
});

const checkBearerPermission = vi.fn();
vi.mock('../../../lib/verify-bearer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/verify-bearer')>();
  return {
    ...actual,
    checkBearerPermission: (...args: unknown[]) => checkBearerPermission(...(args as [])),
  };
});

import { findTool } from '../tools';

/** Same membership-table stub as the REST suite: services both
 * `resolveMembershipId`'s `.eq().eq().single()` chain and the actor-name
 * resolver's `.eq().in()` chain off the shared `.from().select().eq()` root. */
function membershipSupabaseClient(callerMembershipId: string | null) {
  const afterFirstEq = {
    eq: () => ({ single: async () => ({ data: callerMembershipId ? { id: callerMembershipId } : null }) }),
    in: async () => ({ data: [] }),
  };
  return {
    from: () => ({ select: () => ({ eq: () => afterFirstEq }) }),
  };
}

function buildBearerContext(): AppContext {
  return {
    req: { method: 'POST', path: '/v1/mcp' },
    env: { CLICKHOUSE_HOST: 'http://ch.local', OAUTH_STATE_SECRET: 'a'.repeat(32) },
    get: vi.fn((key: string) =>
      key === 'user'
        ? {
            authMode: 'bearer',
            tenantId: 'tenant-1',
            appId: 'app-1',
            gatewayUserId: 'user-1',
            userJwt: 'jwt-1',
            permissions: [],
          }
        : undefined,
    ),
  } as unknown as AppContext;
}

function buildApiKeyContext(permissions: string[] = ['session.read']): AppContext {
  return {
    req: { method: 'POST', path: '/v1/mcp' },
    env: { CLICKHOUSE_HOST: 'http://ch.local', OAUTH_STATE_SECRET: 'a'.repeat(32) },
    get: vi.fn((key: string) =>
      key === 'user'
        ? { authMode: 'apikey', tenantId: 'tenant-1', appId: 'app-1', permissions, apiKeyId: 'key-1' }
        : undefined,
    ),
  } as unknown as AppContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('list_sessions tool', () => {
  it('resolves the async bearer policy before calling the service (self-scoped, no team.read)', async () => {
    checkBearerPermission.mockResolvedValue(false);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-1'));
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const tool = findTool('list_sessions')!;
    const c = buildBearerContext();

    await tool.execute(c, { limit: 25, offset: 0 });

    expect(listSessions).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      { limit: 25, offset: 0 },
      { kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: false },
      expect.any(Object),
    );
  });

  it('stays machine-key team-scoped for an API-key caller (unchanged)', async () => {
    listSessions.mockResolvedValue({ sessions: [], total: 0 });
    const tool = findTool('list_sessions')!;
    const c = buildApiKeyContext(['session.read']);

    await tool.execute(c, { limit: 25, offset: 0 });

    expect(listSessions).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { kind: 'machine-key', canSeeTeamActors: false },
      expect.any(Object),
    );
  });

  // pr filtering resolves a PR/MR number to confirmed-linked trace ids via a
  // Postgres pull_request_session read no gateway host has wired for list
  // reads (see ListSessionsConstraints in @repo/observability-service) — a
  // pr value throws, never reaching the shared service. The dispatcher maps
  // the throw to a structured isError result (proven at the dispatcher
  // level); this pins that execute() itself rejects.
  it('rejects a pr filter, never reaching the shared service', async () => {
    const tool = findTool('list_sessions')!;
    const c = buildApiKeyContext(['session.read']);

    await expect(tool.execute(c, { limit: 25, offset: 0, pr: 812 })).rejects.toThrow(/pr/);
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe('get_session tool', () => {
  it('passes a self-scoped dashboard-member policy for a bearer caller without team.read', async () => {
    checkBearerPermission.mockResolvedValue(false);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-1'));
    getSessionDetail.mockResolvedValue(null);
    const tool = findTool('get_session')!;
    const c = buildBearerContext();

    const result = (await tool.execute(c, { traceId: 'teammates-trace' })) as { error: { code: string } };

    expect(getSessionDetail).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', appId: 'app-1' },
      'teammates-trace',
      { kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: false },
      expect.any(Object),
    );
    expect(result.error.code).toBe('trace_not_found');
  });

  it('flips to team-wide when the bearer caller holds agents.sessions.team.read', async () => {
    checkBearerPermission.mockResolvedValue(true);
    getScopedSupabase.mockResolvedValue(membershipSupabaseClient('membership-1'));
    const detail = { session: { traceId: 't1' }, spans: [], truncated: false, prOutcomes: [] };
    getSessionDetail.mockResolvedValue(detail);
    const tool = findTool('get_session')!;
    const c = buildBearerContext();

    await tool.execute(c, { traceId: 't1' });

    expect(getSessionDetail).toHaveBeenCalledWith(
      expect.any(Object),
      't1',
      { kind: 'dashboard-member', membershipId: 'membership-1', canSeeTeam: true },
      expect.any(Object),
    );
  });
});
