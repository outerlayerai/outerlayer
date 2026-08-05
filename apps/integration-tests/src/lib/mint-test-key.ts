/**
 * Shared test helper: mint a REAL peppered API key against local Supabase.
 *
 * The gateway verifies API keys via the peppered-HMAC → `verify_api_key` RPC
 * (Postgres key-store) — there is no `DEV_SKIP_UNKEY` bypass. Tests
 * that authenticate to the local gateway must therefore send a real key whose
 * digest was computed with the SAME pepper the gateway runs with.
 *
 * This module has NO dependency on the gateway-http harness (`setup-gateway`),
 * so it is safe to import from the vitest `parallel` project (which does not
 * boot a gateway via globalSetup). `gateway-http/client.ts` re-exports
 * `mintTestApiKey` from here so the two suites can never drift on the mint or
 * pepper-resolution logic.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintApiKey } from '@repo/api-key-service';
import { createSupabaseAdminClient } from './supabase-admin';

// Repo root, relative to this file (…/apps/integration-tests/src/lib).
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const GATEWAY_DEV_VARS = join(REPO_ROOT, 'apps', 'gateway', '.dev.vars');

/**
 * Resolve the HMAC pepper the gateway is running with. Prefer the in-process
 * env var; fall back to the `.dev.vars` the harness swapped in before boot
 * (Vitest workers don't inherit globalSetup's env mutations). The minted key's
 * digest MUST use the same pepper the gateway verifies with, or it won't
 * authenticate.
 */
export function resolvePepper(): string {
  const fromEnv = process.env.API_KEY_PEPPER;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  if (existsSync(GATEWAY_DEV_VARS)) {
    const m = readFileSync(GATEWAY_DEV_VARS, 'utf8').match(/^API_KEY_PEPPER=(.*)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  throw new Error(
    `API_KEY_PEPPER not in process.env and not found in ${GATEWAY_DEV_VARS}`,
  );
}

export interface MintTestApiKeyOptions {
  tenantId: string;
  appId: string;
  environmentId: string;
  permissions: string[];
  name?: string;
  /** ISO timestamp; omit for a never-expiring key. Past value → expired key. */
  expiresAt?: string | null;
  /** Optional env-kind scoping written to `allowed_env_kinds`. */
  allowedEnvKinds?: string[] | null;
}

/**
 * Mint a real peppered API key directly against local Supabase (via the
 * service-role admin client). Returns the plaintext to send as a Bearer token.
 */
export async function mintTestApiKey(opts: MintTestApiKeyOptions): Promise<string> {
  const admin = createSupabaseAdminClient();
  const { plaintext } = await mintApiKey({
    rowClient: admin,
    adminClient: admin,
    pepper: resolvePepper(),
    tenantId: opts.tenantId,
    appId: opts.appId,
    name: opts.name ?? `test-key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    environmentId: opts.environmentId,
    allowedEnvKinds: opts.allowedEnvKinds ?? null,
    permissions: opts.permissions,
    isMachine: true,
    createdBy: null,
    expiresAt: opts.expiresAt ?? null,
    replaceExisting: false,
  });
  return plaintext;
}
