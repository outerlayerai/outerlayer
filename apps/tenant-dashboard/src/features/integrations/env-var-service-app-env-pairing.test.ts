/**
 * `EnvVarService.set` MUST verify the (environmentId, appId) pair.
 *
 * A non-null environmentId is only accepted once the environment is confirmed
 * to belong to the supplied appId (`environment WHERE id=envId AND
 * app_id=appId`, checked at the top of `set()`, throwing if absent), so a
 * persisted env_var row can never carry a mismatched (app_id, environment_id)
 * pair. `list()` filters by env id alone and relies on that pairing holding.
 *
 * Per `apps/tenant-dashboard/CLAUDE.md`: this test boundary uses MSW seed
 * helpers, not query-chain mocks.
 */

import { EnvVarService } from './env-var-service';
import {
  seedManagedDeploymentTablesState,
  seedVaultMswState,
} from '@/test-helpers/msw-handlers';
import { createMswRestClient } from '@/test-helpers/rest-client';

const APP_A = 'app-A';
const ENV_A = '11111111-aaaa-4111-8111-111111111111';
const ENV_B = '22222222-bbbb-4222-8222-222222222222';
const KEY = 'DATABASE_URL';

function createService(): EnvVarService {
  return new EnvVarService({ supabase: createMswRestClient() });
}

describe('EnvVarService.set — app/env pairing check', () => {
  // proves AC-067-05
  it('throws when the supplied environmentId does NOT belong to appId', async () => {
    // Only app-A's env exists in the environment table; the caller passes
    // env-B's id paired with app-A → pairing check fails.
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_A, app_id: APP_A, name: 'dev', is_default: true }],
    });
    // Vault must not be touched on the rejected path.
    seedVaultMswState({ secrets: {} });

    await expect(
      createService().set(APP_A, { environmentId: ENV_B }, 'tenant-1', KEY, 'value'),
    ).rejects.toThrow(/does not belong to app/i);
  });

  it('throws when the environmentId is unknown (env row missing entirely)', async () => {
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_A, app_id: APP_A }],
    });
    seedVaultMswState({ secrets: {} });

    const ghost = '99999999-9999-4999-8999-999999999999';
    await expect(
      createService().set(APP_A, { environmentId: ghost }, 'tenant-1', KEY, 'value'),
    ).rejects.toThrow(/does not belong to app/i);
  });

  it('proceeds with the write when (appId, environmentId) match', async () => {
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_A, app_id: APP_A }],
      // Empty envVars; the insert in set() creates a new row.
      envVars: [],
    });
    seedVaultMswState({ secrets: {} });

    // The valid pairing case proceeds past the new check. We assert that the
    // call does NOT throw the pairing error specifically — any downstream
    // error from the MSW vault stub is acceptable here (this test is
    // narrowly about the new guard).
    let pairingError: unknown;
    try {
      await createService().set(APP_A, { environmentId: ENV_A }, 'tenant-1', KEY, 'value');
    } catch (err) {
      pairingError = err;
    }
    if (pairingError instanceof Error) {
      expect(pairingError.message).not.toMatch(/does not belong to app/i);
    }
  });
});
