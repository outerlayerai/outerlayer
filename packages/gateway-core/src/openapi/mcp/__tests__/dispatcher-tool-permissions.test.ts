/**
 * Tool → permission binding for `POST /v1/mcp`'s `tools/call` dispatch.
 *
 * `dispatcher.test.ts` fakes the tool table to pin protocol-level behavior;
 * this suite deliberately leaves `../tools` unmocked so it drives the REAL
 * `MCP_TOOLS` catalog — a hardcoded permission in the dispatcher (instead of
 * reading `tool.requiredPermission`) would pass every test in that file
 * (its single fake tool only exercises one permission) but fail here, since
 * the real catalog carries more than one distinct permission
 * (`metrics.read` for most tools, `session.read` for `list_sessions` and
 * `get_session`).
 *
 * `enforcePermission` always denies here, so `tool.execute` never runs —
 * these tests only need the guard-call arguments, never a live
 * ClickHouse/Supabase-backed executor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../../routes/_shared';

const enforcePermission = vi.fn();
vi.mock('../../../lib/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/permissions')>();
  return { ...actual, enforcePermission: (...args: unknown[]) => enforcePermission(...args) };
});

import { handleMcpRequest } from '../dispatcher';
import { MCP_TOOLS } from '../tools';

/** Minimal valid `arguments` for tools whose input schema has required
 * fields — enough to clear zod validation and reach the permission guard,
 * never enough to matter (the guard denies before `execute` runs). */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  get_session: { traceId: 'trace-1' },
  compare_windows: { aFrom: '2026-01-01', aTo: '2026-01-07', bFrom: '2026-01-08', bTo: '2026-01-14' },
  get_breakdown: { dimension: 'model' },
};

function buildContext(body: unknown): AppContext {
  return {
    req: { method: 'POST', path: '/v1/mcp', json: vi.fn(async () => body) },
    env: {},
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1', permissions: [] } : undefined)),
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as AppContext;
}

describe('tools/call binds each tool to its own declared permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Deny outright: proves the guard argument without ever reaching a real
    // executor.
    enforcePermission.mockImplementation(
      () => async (c: AppContext) => c.json({ error: { code: 'forbidden', message: 'nope' } }, 403 as never),
    );
  });

  it('the real catalog carries more than one distinct permission (or this suite would not catch a hardcoded constant)', () => {
    const distinct = new Set(MCP_TOOLS.map((t) => t.requiredPermission));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it.each(MCP_TOOLS.map((t) => [t.name, t.requiredPermission] as const))(
    '%s calls enforcePermission with its declared permission %s',
    async (name, requiredPermission) => {
      const args = MINIMAL_ARGS[name] ?? {};
      const c = buildContext({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

      await handleMcpRequest(c);

      expect(enforcePermission).toHaveBeenCalledExactlyOnceWith(requiredPermission);
    },
  );
});
