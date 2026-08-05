/**
 * App Management Test Utilities
 *
 * Provides test helpers for creating and cleaning up app-related test data.
 * Each test seeds its own rows and deletes them in the same block.
 *
 * NOTE: The app table has minimal columns:
 * - id, tenant_id, name, created_at, created_by, updated_at, updated_by
 *
 * Git connection info is stored separately in git_connection table.
 *
 * Usage:
 * ```typescript
 * import { createTestApp, cleanupTestApps } from '../../lib/app-test-utils';
 *
 * describe('App Tests', () => {
 *   afterEach(async () => {
 *     await cleanupTestApps(tenantId);
 *   });
 *
 *   it('should work', async () => {
 *     const app = await createTestApp(tenantId, { name: 'My App' });
 *     // test...
 *   });
 * });
 * ```
 */

import { getSupabaseAdmin } from './test-utils';
import { retryOnTransientError } from './retry';
import { ensureDefaultEnvironment } from './environment-test-utils';
import { randomInt, randomUUID } from 'crypto';

// ============================================================================
// Type Definitions
// ============================================================================

export interface AppParams {
  name: string;
}

export interface TestApp {
  id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
  createdBy?: string;
  /**
   * The app's auto-created default `dev` environment id.
   * `api_key.environment_id` and `deployment.environment_id` are NOT NULL,
   * so insert sites in tests bind to this. Mirrors production, where the
   * app-creation server action provisions a default env per app.
   */
  defaultEnvironmentId: string;
}

// Track created apps for cleanup
const createdApps: Map<string, Set<string>> = new Map();

// Track created git connections for cleanup
const createdGitConnections: Map<string, Set<string>> = new Map();

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a test app in the database.
 *
 * @param tenantId - The tenant ID to create the app for
 * @param params - Optional parameters for the app
 * @returns The created app
 *
 * @example
 * ```typescript
 * const app = await createTestApp(tenantId);
 * const customApp = await createTestApp(tenantId, { name: 'Custom Name' });
 * ```
 */
export async function createTestApp(
  tenantId: string,
  params?: Partial<AppParams>
): Promise<TestApp> {
  const admin = getSupabaseAdmin();
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);

  const appName = params?.name || `test-app-${timestamp}-${randomId}`;

  const { data, error } = await retryOnTransientError(() =>
    admin
      .from('app')
      .insert({
        tenant_id: tenantId,
        name: appName,
      })
      .select()
      .single()
  );

  if (error || !data) {
    throw new Error(`Failed to create test app: ${error?.message ?? 'no row returned'}`);
  }

  // Track for cleanup
  if (!createdApps.has(tenantId)) {
    createdApps.set(tenantId, new Set());
  }
  createdApps.get(tenantId)!.add(data.id);

  // Every app has exactly one default `dev` env. As of the
  // `on_create_seed_default_env` trigger (migration 20260529221911) it is
  // seeded automatically when the app row is inserted above, so we just resolve
  // its id. `ensureDefaultEnvironment` is fetch-or-create — robust whether or
  // not the trigger is present — whereas a raw insert here would now collide
  // with the trigger-seeded row (23505).
  const defaultEnvironmentId = await ensureDefaultEnvironment(
    data.id,
    data.tenant_id,
  );

  return {
    id: data.id,
    tenantId: data.tenant_id,
    name: data.name,
    createdAt: new Date(data.created_at ?? Date.now()),
    createdBy: data.created_by ?? undefined,
    defaultEnvironmentId,
  };
}

// ============================================================================
// Cleanup Functions
// ============================================================================

/**
 * Cleans up all test apps for a specific tenant.
 * Should be called in afterEach or afterAll.
 *
 * @param tenantId - The tenant ID to clean up apps for
 */
export async function cleanupTestApps(tenantId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const appIds = createdApps.get(tenantId);

  if (!appIds || appIds.size === 0) {
    return;
  }

  const ids = Array.from(appIds);

  try {
    // Delete associated data first (respecting foreign keys), then apps — batch per table
    await admin.from('api_key').delete().in('app_id', ids);
    await admin.from('git_connection').delete().in('app_id', ids);
    await admin.from('environment').delete().in('app_id', ids);
    await admin.from('app').delete().in('id', ids);
  } catch (error) {
    console.warn(`Failed to cleanup apps for tenant ${tenantId}:`, error);
  }

  // Clear tracked apps
  createdApps.delete(tenantId);
}

// ============================================================================
// Query Helpers
// ============================================================================

/**
 * Gets an app by ID.
 *
 * @param appId - The app ID to fetch
 * @returns The app or null if not found
 */
export async function getTestApp(appId: string): Promise<TestApp | null> {
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from('app')
    .select('*')
    .eq('id', appId)
    .single();

  if (error || !data) {
    return null;
  }

  const { data: env } = await admin
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();

  return {
    id: data.id,
    tenantId: data.tenant_id,
    name: data.name,
    createdAt: new Date(data.created_at ?? Date.now()),
    createdBy: data.created_by ?? undefined,
    defaultEnvironmentId: env?.id ?? '',
  };
}

// ============================================================================
// Git Connection Helpers
// ============================================================================

export interface GitConnectionParams {
  provider: 'github' | 'gitlab';
  appId: string;
  repository?: string;
  installationId?: number;
}

export interface TestGitConnection {
  id: string;
  tenantId: string;
  appId: string;
  provider: 'github' | 'gitlab';
  repository?: string;
  installationId?: number;
  createdAt: Date;
}

/**
 * Creates a test git connection in the database.
 * Note: git_connection requires an app_id reference.
 *
 * @param tenantId - The tenant ID to create the connection for
 * @param params - Parameters for the connection (appId is required)
 * @returns The created git connection
 */
/**
 * A `git_connection.installation_id` no other fixture will pick.
 *
 * The column is globally unique — one GitHub App installation belongs to one
 * app in one tenant (`excl_git_connection_installation_one_tenant`) — so
 * fixtures cannot share a literal. Seeded randomly rather than from the clock:
 * vitest runs test files in separate worker processes, and two workers starting
 * in the same millisecond would otherwise pick the same seed and raise 23P01.
 * Ids live in [2.0e9, 2.1e9) — inside the column's int4 range but far above
 * GitHub's real installation ids — and step per call so parallel files in one
 * worker stay distinct.
 */
let installationIdSeed = 2_000_000_000 + randomInt(0, 100_000_000);
export function uniqueInstallationId(): number {
  installationIdSeed += 1;
  return installationIdSeed;
}

export async function createTestGitConnection(
  tenantId: string,
  params: GitConnectionParams
): Promise<TestGitConnection> {
  const admin = getSupabaseAdmin();
  const provider = params.provider || 'github';
  const { data, error } = await retryOnTransientError(() =>
    admin
    .from('git_connection')
    .insert({
      id: randomUUID(),
      tenant_id: tenantId,
      app_id: params.appId,
      provider,
      repository: params.repository,
      installation_id: params.installationId ?? uniqueInstallationId(),
    })
    .select()
    .single()
  );

  if (error || !data) {
    throw new Error(`Failed to create test git connection: ${error?.message ?? 'no row returned'}`);
  }

  // Track for cleanup
  if (!createdGitConnections.has(tenantId)) {
    createdGitConnections.set(tenantId, new Set());
  }
  createdGitConnections.get(tenantId)!.add(data.id);

  return {
    id: data.id,
    tenantId: data.tenant_id,
    appId: data.app_id,
    provider: data.provider as GitConnectionParams['provider'],
    repository: data.repository ?? undefined,
    installationId: data.installation_id ?? undefined,
    createdAt: new Date(data.created_at ?? Date.now()),
  };
}

/**
 * Cleans up all test git connections for a specific tenant.
 *
 * @param tenantId - The tenant ID to clean up connections for
 */
export async function cleanupTestGitConnections(tenantId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const connectionIds = createdGitConnections.get(tenantId);

  if (!connectionIds || connectionIds.size === 0) {
    return;
  }

  for (const connectionId of connectionIds) {
    try {
      await admin.from('git_connection').delete().eq('id', connectionId);
    } catch (error) {
      console.warn(`Failed to cleanup git connection ${connectionId}:`, error);
    }
  }

  createdGitConnections.delete(tenantId);
}
