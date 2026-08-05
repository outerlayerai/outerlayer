import "server-only";

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/db';
import type { DomainSSOCheck } from '@/types/sso';

/**
 * Login-flow SSO domain check — deliberately OPEN code (not `ee/`).
 *
 * The password-login guard consults this on every login attempt, so it must
 * run on unlicensed self-hosted instances too (where no SSO config exists it
 * returns `{ hasSso: false, enforced: false }` and password login proceeds).
 * Configuring SAML SSO — the feature that WRITES `sso_config` — is EE
 * (`ee/features/sso`); enforcing an existing config at login is core auth.
 * Same recording-vs-viewing split as the audit log.
 */
export async function checkDomainSSOStatus(
  adminDb: SupabaseClient<Database>,
  domain: string,
): Promise<DomainSSOCheck> {
  const { data, error } = await adminDb
    .from('sso_config')
    .select('is_active, enforcement_enabled')
    .contains('allowed_domains', [domain])
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check domain SSO: ${error.message}`);
  }

  if (!data) {
    return { hasSso: false, enforced: false };
  }

  return {
    hasSso: true,
    enforced: (data as { enforcement_enabled: boolean }).enforcement_enabled,
  };
}
