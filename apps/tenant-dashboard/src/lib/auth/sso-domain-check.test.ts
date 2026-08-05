/**
 * Direct unit tests for the login-flow SSO domain check.
 *
 * checkDomainSSOStatus is the OPEN half of the ee/ SSO split: the
 * login form consults it on every password login, so it must behave exactly
 * right on any instance — a wrong `enforced` locks users out (or lets a
 * password bypass an SSO-enforced org), and a wrong filter matches the wrong
 * tenant's config. The action layer mocks this module as a seam, so these
 * tests are the only direct killers for its mutants.
 *
 * Supabase is faked at the HTTP layer via MSW (seedSupabaseMswState) per the
 * dashboard testing rules; the sso_config handler emulates the `contains` +
 * `eq` filters for real, so the query-construction cases below assert
 * behavior, not query strings.
 */

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { seedSupabaseMswState } from '@/test-helpers/msw-handlers';
import { checkDomainSSOStatus } from './sso-domain-check';

function db() {
  return createSupabaseAdminClient();
}

const activeEnforced = {
  tenant_id: 'tenant-001',
  allowed_domains: ['example.com', 'example.io'],
  is_active: true,
  enforcement_enabled: true,
};

describe('checkDomainSSOStatus', () => {
  it('reports hasSso + enforced for a domain with an active, enforced config', async () => {
    seedSupabaseMswState({ ssoConfigs: [activeEnforced] });

    expect(await checkDomainSSOStatus(db(), 'example.com')).toEqual({
      hasSso: true,
      enforced: true,
    });
  });

  it('reports hasSso without enforcement when the active config does not enforce', async () => {
    seedSupabaseMswState({
      ssoConfigs: [{ ...activeEnforced, enforcement_enabled: false }],
    });

    expect(await checkDomainSSOStatus(db(), 'example.com')).toEqual({
      hasSso: true,
      enforced: false,
    });
  });

  it('reports no SSO when no config exists at all', async () => {
    expect(await checkDomainSSOStatus(db(), 'example.com')).toEqual({
      hasSso: false,
      enforced: false,
    });
  });

  it("does not match another tenant's config for a different domain", async () => {
    // Kills the `[domain]` → `[]` containment mutation: an empty containment
    // matches every row, so this seeded row would wrongly report SSO for
    // unrelated.com.
    seedSupabaseMswState({ ssoConfigs: [activeEnforced] });

    expect(await checkDomainSSOStatus(db(), 'unrelated.com')).toEqual({
      hasSso: false,
      enforced: false,
    });
  });

  it('ignores an inactive config even when the domain matches', async () => {
    // Kills `.eq('is_active', true)` mutations (flip or drop): a deactivated
    // SSO config must never gate password logins.
    seedSupabaseMswState({
      ssoConfigs: [{ ...activeEnforced, is_active: false }],
    });

    expect(await checkDomainSSOStatus(db(), 'example.com')).toEqual({
      hasSso: false,
      enforced: false,
    });
  });

  it('throws with the lookup error message when the read fails', async () => {
    seedSupabaseMswState({
      ssoConfigs: [activeEnforced],
      tableErrors: { sso_config_select: { message: 'connection refused' } },
    });

    await expect(checkDomainSSOStatus(db(), 'example.com')).rejects.toThrow(
      'Failed to check domain SSO: connection refused',
    );
  });
});
