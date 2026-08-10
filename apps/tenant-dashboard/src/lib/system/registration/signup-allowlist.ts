import "server-only";

import { SIGNUP_EMAIL_ALLOWLIST } from "../../../config-global.server";
import { parseEmailAllowlist, isEmailAllowed } from "../../email-allowlist";

/**
 * Registration gate for deployments that are not open to the public.
 *
 * Both registration paths — email/password and OAuth — run every new address
 * through this. OAuth matters as much as the form: an environment with GitHub
 * or Google sign-in enabled hands an account to anyone who clicks the button,
 * so gating only the form would leave the wider door open.
 *
 * Unset `SIGNUP_EMAIL_ALLOWLIST` means open registration, which is what the
 * hosted product wants. It exists for an environment that is reachable on the
 * public internet but is only meant for a known set of people — a staging
 * deployment used for dogfooding.
 *
 * This gate governs *self-service* registration only. Invited users are
 * created through the Supabase admin API by {@link MembershipService}, which
 * never reaches this path, so an allowlisted deployment still onboards whoever
 * an admin deliberately invites.
 */
export function isSignupEmailAllowed(email: string): boolean {
  return isEmailAllowed(email, parseEmailAllowlist(SIGNUP_EMAIL_ALLOWLIST));
}

/**
 * Deliberately says nothing about what the allowlist contains: a stranger
 * probing the form learns only that registration is closed, not which domain
 * would get them in.
 */
export const SIGNUP_NOT_ALLOWED_ERROR =
  "Registration is not open on this deployment. Ask an administrator for an invitation.";
