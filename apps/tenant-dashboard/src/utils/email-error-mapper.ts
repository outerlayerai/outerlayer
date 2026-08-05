import { AuthError } from '@supabase/supabase-js';
import { EmailChangeErrorCode } from '../types/email-change';

/**
 * Extracts the error code from a Supabase AuthError.
 * Translation happens in the component via i18n keys matching these codes.
 */
export function getEmailChangeErrorCode(error: AuthError | Error | unknown): EmailChangeErrorCode {
  if (!error) return 'unknown';

  if (typeof error === 'object' && error !== null) {
    const authError = error as AuthError;

    // Check error code directly
    if (authError.code) {
      if (authError.code === 'email_exists') return 'email_exists';
      if (authError.code === 'email_address_invalid') return 'email_address_invalid';
      if (authError.code === 'user_sso_managed') return 'user_sso_managed';
      if (authError.code === 'over_request_rate_limit') return 'over_request_rate_limit';
    }

    // Check message for patterns
    const message = authError.message?.toLowerCase() || '';

    if (message.includes('email') && message.includes('exists')) return 'email_exists';
    if (message.includes('invalid') && message.includes('email')) return 'email_address_invalid';
    if (message.includes('sso') || message.includes('managed')) return 'user_sso_managed';
    if (message.includes('rate') || message.includes('too many')) return 'over_request_rate_limit';
    if (message.includes('session') || message.includes('expired')) return 'session_expired';
    if (message.includes('duplicate') || message.includes('key')) return 'duplicate_key';
  }

  return 'unknown';
}
