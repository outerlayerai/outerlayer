"use server";

import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { checkDomainSSOStatus } from "@/lib/auth/sso-domain-check";
import type { DomainSSOCheck } from "@/types/sso";

// ---------------------------------------------------------------------------
// Login-flow SSO guards — OPEN code by design.
//
// Only the two actions the login form consults live here. SAML SSO
// *configuration* (the feature that creates `sso_config` rows) is EE and
// lives in ee/features/sso/actions.ts; enforcing an
// already-configured SSO domain at login is core auth and must work on
// unlicensed self-hosted instances.
// ---------------------------------------------------------------------------

/**
 * Server-side guard: verifies that password-based login is permitted for the
 * given email address. Returns { allowed: false } when the email domain belongs
 * to a tenant with SSO enforcement enabled, preventing password login bypass.
 *
 * Called from the login form before invoking supabase.auth.signInWithPassword
 * so that enforcement is checked server-side in addition to the client-side UI gate.
 */
export async function validatePasswordLoginAllowed(
  email: string,
): Promise<{ allowed: boolean; error?: string }> {
  try {
    const domain = email.split("@")[1];

    if (!domain) {
      return { allowed: true };
    }

    const adminDb = createSupabaseAdminClient();
    const check = await checkDomainSSOStatus(adminDb, domain);

    if (check.enforced) {
      return {
        allowed: false,
        error:
          "Your organization requires SSO authentication. Password-based login is not permitted.",
      };
    }

    return { allowed: true };
  } catch (err) {
    console.error("[SSO] validatePasswordLoginAllowed failed:", err);
    // Fail open — don't block login if the SSO check itself errors.
    // Surface the failure so callers can warn the user.
    return { allowed: true, error: "SSO enforcement check is temporarily unavailable." };
  }
}

export async function checkDomainSSO(email: string): Promise<DomainSSOCheck & { error?: string }> {
  try {
    const domain = email.split("@")[1];

    if (!domain) {
      return { hasSso: false, enforced: false };
    }

    const adminDb = createSupabaseAdminClient();
    return await checkDomainSSOStatus(adminDb, domain);
  } catch (err) {
    console.error("[SSO] checkDomainSSO failed — returning error to caller:", err);
    return { hasSso: false, enforced: false, error: "Unable to check SSO status" };
  }
}
