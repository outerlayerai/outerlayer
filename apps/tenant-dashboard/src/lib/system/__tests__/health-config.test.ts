/**
 * The `config` dependency inside checkHealth.
 *
 * It reports posture, so it must never drag overall health down: a deployment
 * deliberately running with email off is working as configured, and paging on
 * that trains people to ignore the page. It is also counted rather than named —
 * /api/health is unauthenticated, and the list of what a deployment cannot do
 * is not something to hand a passer-by.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ posture: vi.fn(), supabase: vi.fn(), clickhouse: vi.fn() }));

vi.mock('@/lib/system/env-readiness', () => ({
  checkConfigPosture: m.posture,
  postureEnvFromProcess: () => ({}),
}));

vi.mock('@/lib/system/admin-client', () => ({
  getAdminDataClient: () => ({
    from: () => ({ select: () => ({ limit: m.supabase }) }),
  }),
}));

vi.mock('@/lib/analytics/client', () => ({
  getClickHouseClient: () => ({ query: m.clickhouse }),
}));

import { checkHealth } from '../health';

function dependency(health: Awaited<ReturnType<typeof checkHealth>>, name: string) {
  return health.dependencies.find((d) => d.name === name);
}

describe('checkHealth — config dependency', () => {
  beforeEach(() => {
    m.posture.mockReset();
    m.supabase.mockResolvedValue({ error: null });
    m.clickhouse.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is healthy when nothing is switched off', async () => {
    m.posture.mockReturnValue({ environment: 'production', degraded: [] });

    const health = await checkHealth();

    expect(dependency(health, 'config')).toEqual({ name: 'config', status: 'healthy' });
  });

  it('counts reduced capabilities without naming them', async () => {
    m.posture.mockReturnValue({
      environment: 'preview',
      degraded: [
        { capability: 'email delivery', reason: 'EMAIL_ENABLED is not truthy' },
        { capability: 'GitHub App', reason: 'GITHUB_APP_PRIVATE_KEY is unset' },
      ],
    });

    const health = await checkHealth();
    const config = dependency(health, 'config');

    expect(config?.status).toBe('unhealthy');
    expect(config?.error).toBe('2 capability(ies) reduced by configuration');
    expect(config?.error).not.toContain('email');
    expect(config?.error).not.toContain('GITHUB_APP_PRIVATE_KEY');
  });

  // Config is not in CRITICAL_DEPENDENCIES, so a reduced capability degrades
  // the report without making the service look down.
  it('never drives overall status to unhealthy on its own', async () => {
    m.posture.mockReturnValue({
      environment: 'preview',
      degraded: [{ capability: 'billing', reason: 'BILLING_ENABLED is falsy' }],
    });

    const health = await checkHealth();

    expect(health.status).toBe('degraded');
  });
});
