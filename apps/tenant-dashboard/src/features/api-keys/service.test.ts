/**
 * ApiKeysService — env-scoping regression tests for the list read.
 *
 * The bug this pins: the list must resolve the breadcrumb-selected env to a
 * CONCRETE row id (default env included) and filter by it, plus always
 * include kind-scoped keys (`environment_id` NULL, `allowed_env_kinds` set).
 * Filtering on a resolver that returns `null` for the default env would leak
 * every environment's keys into the bare-URL view.
 */

import type { ServiceContext } from '@/lib/action-kit/service-context';
import { createMswRestClient } from '@/test-helpers/rest-client';
import { seedApiKeysMswState, seedSupabaseAuth, seedSupabaseMswState } from '@/test-helpers/msw-handlers';

import { apiKeysService } from './service';

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { tenant_id: 'tenant-1' },
};

async function ctxFor(): Promise<ServiceContext> {
  return { db: createMswRestClient(), tenantId: 'tenant-1', actor: { userId: 'user-1', role: 'owner' } };
}

function seedTwoEnvsWithOneKeyEach() {
  seedSupabaseAuth({ user: mockUser as never });
  seedSupabaseMswState({ apps: [{ id: 'app-1', tenant_id: 'tenant-1', name: 'my-app' }] });
  seedApiKeysMswState({
    environments: [
      { id: 'env-1', app_id: 'app-1', is_default: true, name: 'dev' },
      { id: 'env-2', app_id: 'app-1', is_default: false, name: 'prod' },
    ],
    apiKeys: [
      { id: 'key-dev', api_key_id: 'unkey-dev', app_id: 'app-1', name: 'Dev key', environment_id: 'env-1' },
      { id: 'key-prod', api_key_id: 'unkey-prod', app_id: 'app-1', name: 'Prod key', environment_id: 'env-2' },
    ],
  });
}

describe('ApiKeysService.listForEnv', () => {
  it('lists ONLY the default env keys on the bare URL (no ?env=)', async () => {
    seedTwoEnvsWithOneKeyEach();
    const ctx = await ctxFor();

    const result = await apiKeysService.listForEnv(ctx, 'app-1', undefined);

    expect('unresolved' in result).toBe(false);
    if ('unresolved' in result) throw new Error('unreachable');
    expect(result.apiKeys.map((k) => k.id)).toEqual(['key-dev']);
    expect(result.environmentName).toBe('dev');
  });

  it('lists ONLY the selected env keys for an explicit ?env=', async () => {
    seedTwoEnvsWithOneKeyEach();
    const ctx = await ctxFor();

    const result = await apiKeysService.listForEnv(ctx, 'app-1', 'prod');

    if ('unresolved' in result) throw new Error('unreachable');
    expect(result.apiKeys.map((k) => k.id)).toEqual(['key-prod']);
    expect(result.environmentName).toBe('prod');
  });

  it('fails closed (unresolved) when the env name cannot be resolved — never an unfiltered list', async () => {
    seedTwoEnvsWithOneKeyEach();
    const ctx = await ctxFor();

    const result = await apiKeysService.listForEnv(ctx, 'app-1', 'ghost');

    expect(result).toEqual({ unresolved: true });
  });

  it('ALWAYS lists kind-scoped keys (env pin NULL) regardless of the selected env', async () => {
    seedSupabaseAuth({ user: mockUser as never });
    seedSupabaseMswState({ apps: [{ id: 'app-1', tenant_id: 'tenant-1', name: 'my-app' }] });
    seedApiKeysMswState({
      environments: [
        { id: 'env-1', app_id: 'app-1', is_default: true, name: 'dev' },
        { id: 'env-2', app_id: 'app-1', is_default: false, name: 'prod' },
      ],
      apiKeys: [
        { id: 'key-dev', api_key_id: 'u-dev', app_id: 'app-1', name: 'Dev key', environment_id: 'env-1' },
        {
          id: 'key-kind',
          api_key_id: 'u-kind',
          app_id: 'app-1',
          name: 'Preview CI key',
          environment_id: null,
          allowed_env_kinds: ['preview'],
        },
      ],
    });
    const ctx = await ctxFor();

    const result = await apiKeysService.listForEnv(ctx, 'app-1', 'dev');

    if ('unresolved' in result) throw new Error('unreachable');
    const ids = result.apiKeys.map((k) => k.id).sort();
    expect(ids).toEqual(['key-dev', 'key-kind']);
    expect(ids).not.toContain('key-prod');
  });
});
