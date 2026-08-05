/**
 * Supabase Auth error codes for email updates
 * @see https://supabase.com/docs/guides/auth/debugging/error-codes
 */
export type EmailChangeErrorCode =
  | 'email_exists'
  | 'email_address_invalid'
  | 'user_sso_managed'
  | 'over_request_rate_limit'
  | 'session_expired'
  | 'duplicate_key'
  | 'unknown';

/**
 * Result of an email change request
 */
export interface EmailChangeResult {
  success: boolean;
  errorCode?: EmailChangeErrorCode;
}
