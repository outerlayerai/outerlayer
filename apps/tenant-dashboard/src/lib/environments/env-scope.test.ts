/**
 * Unit tests for `resolveEnvIdForStorage` — the resolver behind the Settings →
 * Environment Variables page (`env-scope.ts`). This is the function whose `null`
 * return produced the user-facing "Could not resolve the selected environment"
 * warning when an app had no default `dev` env.
 *
 * Covers every resolution branch plus the two not-found cases:
 *   - implicit default (no ?env=)   → looks up is_default=true   [bare-URL path]
 *   - by name (?env=staging)        → looks up name=...
 *   - by id (id wins over name)     → looks up id=...
 *   - stale ?env=<gone>             → null   [recovery handled upstream]
 *   - app with NO default env       → null   [the original env-less-app bug]
 *
 * Per `apps/tenant-dashboard/CLAUDE.md`: MSW seed helpers at the Supabase HTTP
 * boundary, not query-chain mocks. A real supabase-js client issues the queries.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { resolveEnvIdForStorage } from './env-scope';
import { seedManagedDeploymentTablesState } from '../../test-helpers/msw-handlers';

const SUPABASE_URL = 'http://localhost:54321';
const SUPABASE_PUBLISHABLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test';

const APP = 'app-1';
const OTHER_APP = 'app-2';
const DEV_ID = '11111111-1111-4111-8111-111111111111';
const STAGING_ID = '22222222-2222-4222-8222-222222222222';

function client(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) as unknown as SupabaseClient;
}

function seedAppWithEnvs(): void {
  seedManagedDeploymentTablesState({
    environments: [
      { id: DEV_ID, app_id: APP, name: 'dev', is_default: true },
      { id: STAGING_ID, app_id: APP, name: 'staging', is_default: false },
    ],
  });
}

describe('resolveEnvIdForStorage', () => {
  it('resolves the default env when no ?env= is supplied (the bare-URL "dev" path)', async () => {
    seedAppWithEnvs();
    const result = await resolveEnvIdForStorage(client(), APP, { envName: null });
    expect(result).toEqual({ envId: DEV_ID, envName: 'dev' });
  });

  it('resolves a named env from ?env=<name>', async () => {
    seedAppWithEnvs();
    const result = await resolveEnvIdForStorage(client(), APP, {
      envName: 'staging',
    });
    expect(result).toEqual({ envId: STAGING_ID, envName: 'staging' });
  });

  it('looks up by explicit env id, and the id wins over a supplied name', async () => {
    seedAppWithEnvs();
    // envId points at staging while envName says dev — id must win.
    const result = await resolveEnvIdForStorage(client(), APP, {
      envId: STAGING_ID,
      envName: 'dev',
    });
    expect(result).toEqual({ envId: STAGING_ID, envName: 'staging' });
  });

  it('returns null for a stale ?env=<name> that matches no env (recovery handled upstream)', async () => {
    seedAppWithEnvs();
    const result = await resolveEnvIdForStorage(client(), APP, {
      envName: 'ghost',
    });
    expect(result).toBeNull();
  });

  it('returns null when the app has NO default env (the original env-less-app bug state)', async () => {
    // Seed an env for a DIFFERENT app only; APP itself has none. The default
    // lookup (app_id=APP AND is_default=true) finds nothing → null, which is
    // exactly what made the page show "Could not resolve the selected
    // environment". The on_create_seed_default_env trigger now prevents this
    // state for newly created apps.
    seedManagedDeploymentTablesState({
      environments: [
        { id: DEV_ID, app_id: OTHER_APP, name: 'dev', is_default: true },
      ],
    });
    const result = await resolveEnvIdForStorage(client(), APP, { envName: null });
    expect(result).toBeNull();
  });
});
