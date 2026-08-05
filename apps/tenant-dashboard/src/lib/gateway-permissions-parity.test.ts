/**
 * Gateway ⇄ Dashboard permissions parity test.
 *
 * The dashboard's `gateway-permissions.ts` drives the UI for minting API
 * keys and writes permission strings into Unkey metadata at key creation
 * time (see `@repo/api-key-service`). The gateway then reads
 * those permissions on every request via `UserMetaSchema` in
 * `packages/gateway-core/src/lib/verify-key.ts`, and a strict `z.enum(...)`
 * over `GATEWAY_PERMISSIONS` (declared in
 * `packages/gateway-core/src/lib/permissions.ts`)
 * means **one** unknown string in the array fails the entire parse → 401
 * on every request from that key.
 *
 * That is exactly the failure mode this test guards against: a permission
 * renamed in the gateway and the SQL enum (e.g. `trace.ingest` →
 * `trace.write`) without this file being updated. SDK-role keys minted by
 * the dashboard would carry the old permission string, which the gateway's
 * Zod schema no longer recognizes, silently breaking authentication on all
 * OpenAPI `/v1/*` routes for any key holding that permission.
 *
 * This parity test reads the gateway's canonical `GATEWAY_PERMISSIONS`
 * list as text (vitest runs from the tenant-dashboard workspace and
 * there is no runtime package boundary between the two apps, so we go
 * through the filesystem rather than adding a new workspace dependency)
 * and asserts:
 *
 *   1. Every key exposed in the dashboard UI is a valid gateway permission
 *      — the SDK/full-access/read-only/custom roles never issue a key
 *      that the gateway would reject.
 *   2. Every gateway permission is exposed in the dashboard UI — new
 *      gateway permissions get UI coverage, rather than being reachable
 *      only by hand-editing Unkey metadata.
 *   3. Every role preset references only valid gateway permissions —
 *      catches role-preset drift even when the top-level list is in sync
 *      (a prior SDK-role regression passed the type check but still
 *      shipped broken role defaults).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GATEWAY_PERMISSIONS, GATEWAY_ROLES } from './gateway-permissions';

// ---------------------------------------------------------------------------
// Extract the canonical permission set from the gateway source
// ---------------------------------------------------------------------------

/**
 * Absolute path to the gateway's canonical permission list. Chosen via a
 * path relative to this test file so the test fails loudly if either side
 * of the monorepo layout shifts unexpectedly.
 */
const GATEWAY_PERMISSIONS_PATH = resolve(
  __dirname,
  '../../../../packages/gateway-core/src/lib/permissions.ts',
);

/**
 * Parse the `GATEWAY_PERMISSIONS` array literal out of the gateway source.
 *
 * We intentionally regex-parse the file rather than importing it as a
 * module — the gateway workspace imports `Database` from its own `db.ts`
 * and runs in a different tsconfig. Reading the source string is a
 * deliberately shallow dependency that doesn't pull in the gateway's
 * build graph.
 */
function readGatewayCanonicalPermissions(): Set<string> {
  const src = readFileSync(GATEWAY_PERMISSIONS_PATH, 'utf8');
  const match = src.match(
    /export const GATEWAY_PERMISSIONS\s*=\s*\[([\s\S]*?)\]\s*as const satisfies/,
  );
  if (!match) {
    throw new Error(
      `Could not locate \`export const GATEWAY_PERMISSIONS = [...] as const satisfies\` in ${GATEWAY_PERMISSIONS_PATH}. ` +
        'The gateway file format changed — update this parity test.',
    );
  }
  const body = match[1]!;
  // Permissions are declared as plain single-quoted string literals:
  //   'trace.write',
  //   'annotation_queue.review',
  const out = new Set<string>();
  for (const [, perm] of body.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) {
    if (!perm) continue;
    out.add(perm);
  }
  if (out.size === 0) {
    throw new Error(
      'Parsed zero permissions from the gateway canonical list — the array format changed. ' +
        'Update the extraction regex in this test.',
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parity assertions
// ---------------------------------------------------------------------------

/**
 * Gateway permissions that are deliberately NOT grantable through the
 * dashboard / API-key minting UI.
 *
 * API keys are app-scoped (bound to one app via X-Outerlayer-App-Id), but
 * `app.{insert,update,delete}` authorize on tenant_id alone at the gateway
 * (`gateway_tenant_{insert,update,delete}_app` RLS + the flat permission
 * check in `apps/gateway/src/lib/permissions.ts`), never against the key's
 * bound app. Exposing them as grantable would let a key minted "for app A"
 * create/rename/delete sibling app B in the same tenant — tenant-wide blast
 * radius from an app-scoped credential. App provisioning therefore lives on
 * the tenant-wide session bearer (`outerlayer login`) / dashboard, not on an
 * API key. `app.read` is intentionally NOT in this set — it stays grantable.
 *
 * These remain in the GATEWAY canonical list (the gateway still recognizes
 * and enforces them for session-bearer callers); they are only withheld from
 * the dashboard's grantable vocabulary.
 */
const UI_EXCLUDED_GATEWAY_PERMISSIONS = new Set<string>([
  'app.insert',
  'app.update',
  'app.delete',
]);

describe('gateway-permissions parity with gateway canonical list', () => {
  const gatewayPerms = readGatewayCanonicalPermissions();
  const dashboardKeys = new Set<string>(GATEWAY_PERMISSIONS.map((p) => p.key));

  it('every dashboard permission key is a valid gateway permission', () => {
    const missingInGateway = [...dashboardKeys].filter((k) => !gatewayPerms.has(k)).sort();
    expect(missingInGateway).toEqual([]);
  });

  it('every gateway permission is exposed in the dashboard UI (except deliberate exclusions)', () => {
    const missingInDashboard = [...gatewayPerms]
      .filter((k) => !dashboardKeys.has(k) && !UI_EXCLUDED_GATEWAY_PERMISSIONS.has(k))
      .sort();
    expect(missingInDashboard).toEqual([]);
  });

  it('deliberately-excluded permissions are gateway-real and dashboard-absent', () => {
    // Guards the carve-out from rotting in either direction: if the gateway
    // ever drops one of these, the exclusion is stale (remove it here); if one
    // ever leaks back into the dashboard vocabulary, the security fix regressed.
    for (const perm of UI_EXCLUDED_GATEWAY_PERMISSIONS) {
      expect(gatewayPerms.has(perm)).toBe(true);
      expect(dashboardKeys.has(perm)).toBe(false);
    }
  });

  it('every role preset references only valid gateway permissions', () => {
    const offenders: Array<{ role: string; permission: string }> = [];
    for (const role of GATEWAY_ROLES) {
      for (const permission of role.permissions) {
        if (!gatewayPerms.has(permission)) {
          offenders.push({ role: role.id, permission });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
