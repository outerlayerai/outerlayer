import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import { hasAdminClientCall, isAllowedHome } from '../check-data-access-boundary.mjs';

/**
 * The detector must flag files that CONSTRUCT the RLS-bypassing admin client
 * outside the sanctioned tiers (evading the review that would otherwise
 * catch a missing permission gate) without false-flagging bare imports,
 * re-exports, or comments — a false fail would erode trust in the gate.
 */
describe('hasAdminClientCall', () => {
  it.each([
    ['const db = createSupabaseAdminClient();', true],
    ['  return createSupabaseAdminClient()', true],
    ['const s = createSupabaseAdminClient ();', true], // whitespace before paren
    ["import { createSupabaseAdminClient } from '@/supabaseAdminClient';", false], // bare import
    ['export { createSupabaseAdminClient };', false], // re-export, no call
    ['// createSupabaseAdminClient() is only allowed in services', false], // comment
    [' * uses createSupabaseAdminClient() under the hood', false], // jsdoc line
    ['const db = createSupabaseServerClient();', false], // the user (RLS) client, not admin
    ['const x = 1;', false],
    ['const db = getAdminDataClient();', true],
    ['  return getAdminDataClient()', true],
    ['const s = getAdminDataClient ();', true], // whitespace before paren
    ["import { getAdminDataClient } from '@/lib/system/admin-client';", false], // bare import
    ['// getAdminDataClient() is confined to lib/system and ee service.ts files', false], // comment
  ])('hasAdminClientCall(%j) === %s', (src, expected) => {
    expect(hasAdminClientCall(src as string)).toBe(expected);
  });

  it('flags a call even when the same file also imports it', () => {
    const src = [
      "import { createSupabaseAdminClient } from '@/supabaseAdminClient';",
      'export async function leak() {',
      '  const db = createSupabaseAdminClient();',
      '  return db.from("sso_config").update({});',
      '}',
    ].join('\n');
    expect(hasAdminClientCall(src)).toBe(true);
  });
});

describe('isAllowedHome', () => {
  it.each([
    // Allowed: the service layer + the factory module
    ['apps/tenant-dashboard/src/services/sso/sso-config-service.ts', true],
    ['apps/tenant-dashboard/ee/services/sso/sso-config-service.ts', true],
    ['apps/tenant-dashboard/src/supabaseAdminClient.ts', true],
    // Allowed: the new-world system layer — the sole home of getAdminDataClient
    ['apps/tenant-dashboard/src/lib/system/admin-client.ts', true],
    ['apps/tenant-dashboard/src/lib/system/list-tenant-members.ts', true],
    // Not allowed: routes, pages, section-level actions — a missing permission
    // gate here silently exposes cross-tenant data, unlike inside a service.
    ['apps/tenant-dashboard/src/sections/admin/settings/actions.ts', false],
    ['apps/tenant-dashboard/src/app/auth/callback/route.ts', false],
    ['apps/tenant-dashboard/ee/sections/sso/actions.ts', false],
    ['apps/tenant-dashboard/src/utils/permission-check.ts', false],
    // A "services" segment that is NOT the app's service layer must not be exempt.
    ['apps/tenant-dashboard/src/lib/services-helper.ts', false],
    // EE feature service.ts files legitimately call getAdminDataClient, but
    // that's enforced by the eslint import-boundary rail, not this gate —
    // this ratchet only exempts the two homes above; a feature's service.ts
    // still flags here (and belongs in the baseline) until it's re-homed.
    ['apps/tenant-dashboard/ee/features/custom-roles/service.ts', false],
  ])('isAllowedHome(%j) === %s', (relPath, expected) => {
    expect(isAllowedHome(relPath as string)).toBe(expected);
  });
});
