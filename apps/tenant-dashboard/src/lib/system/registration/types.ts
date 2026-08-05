import "server-only";

/**
 * Registration Service Types
 *
 * Simplified for skip-company-setup:
 * - Registration only creates auth user + profile
 * - No Stripe/Unkey during registration (deferred to org creation)
 * - No saga tracking needed
 */

// Service configuration interfaces
export interface RegistrationServiceConfig {
  supabaseClient?: any;
}

export interface OAuthRegistrationServiceConfig {
  // Currently empty - OAuth registration uses admin client only
}
