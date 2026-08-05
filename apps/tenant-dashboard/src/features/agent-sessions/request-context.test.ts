/**
 * `resolveAgentSessionsContext` — the app-access gate on the React Server
 * Component (RSC) side. Pins the
 * narrowed catch: `verifyAppAccess`'s ordinary denial (`ForbiddenError`, a
 * foreign-tenant or nonexistent app) resolves to the same `null` a typo'd
 * `appName` gets — no existence oracle. An UNEXPECTED error (anything else)
 * must never collapse into that same `null`/`notFound()` — it has to reach
 * the error boundary, or a real outage would silently render as a 404.
 */
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { getAppIdByNameMock, loadRequestServiceContextMock, verifyAppAccessMock, loggerErrorMock } = vi.hoisted(() => ({
  getAppIdByNameMock: vi.fn(),
  loadRequestServiceContextMock: vi.fn(),
  verifyAppAccessMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/utils/get-app-id', () => ({ getAppIdByName: getAppIdByNameMock }));
vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: loadRequestServiceContextMock,
  logServerError: loggerErrorMock,
}));
vi.mock('@/lib/analytics/tenant-context', () => ({ verifyAppAccess: verifyAppAccessMock }));

import { ForbiddenError, ValidationError } from '@repo/observability-service';
import { resolveAgentSessionsContext } from './request-context';

const CTX = { db: {}, tenantId: 'tenant-1', actor: { userId: 'user-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  getAppIdByNameMock.mockResolvedValue('app-1');
  loadRequestServiceContextMock.mockResolvedValue(CTX);
});

it("resolves null when appName doesn't name a readable app — no verifyAppAccess call", async () => {
  getAppIdByNameMock.mockResolvedValue(null);

  const result = await resolveAgentSessionsContext('typo-name');

  expect(result).toBeNull();
  expect(verifyAppAccessMock).not.toHaveBeenCalled();
});

it('resolves the verified context on success', async () => {
  verifyAppAccessMock.mockResolvedValue({ tenantId: 'tenant-1', appId: 'app-1', dataRetentionDays: -1 });

  const result = await resolveAgentSessionsContext('acme-app');

  expect(result).toMatchObject({ tenantId: 'tenant-1', appId: 'app-1', db: CTX.db });
  expect(loggerErrorMock).not.toHaveBeenCalled();
});

it('maps a ForbiddenError (foreign-tenant or nonexistent app) to null — the same outcome as a typo, no oracle', async () => {
  verifyAppAccessMock.mockRejectedValue(new ForbiddenError('Access denied to this application'));

  const result = await resolveAgentSessionsContext('foreign-app');

  expect(result).toBeNull();
  expect(loggerErrorMock).not.toHaveBeenCalled();
});

it('maps a ValidationError to null the same way', async () => {
  verifyAppAccessMock.mockRejectedValue(new ValidationError('tenantId is required'));

  const result = await resolveAgentSessionsContext('acme-app');

  expect(result).toBeNull();
});

it('logs and RETHROWS an unexpected error instead of masquerading it as a 404', async () => {
  const outage = new Error('ClickHouse connection refused');
  verifyAppAccessMock.mockRejectedValue(outage);

  await expect(resolveAgentSessionsContext('acme-app')).rejects.toThrow('ClickHouse connection refused');
  expect(loggerErrorMock).toHaveBeenCalledWith(outage, expect.objectContaining({ appName: 'acme-app' }));
});
