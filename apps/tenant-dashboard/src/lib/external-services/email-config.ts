import "server-only";

/**
 * resolveEmailConfig — the email-delivery toggle.
 *
 * Decides whether transactional email is enabled and which provider backend to
 * wire (`resend` for the hosted product, `smtp`/Nodemailer for self-hosters).
 * Pure: the caller passes the already-read `EMAIL_ENABLED` / `EMAIL_PROVIDER`
 * env strings in, so the decision is unit-testable without reloading the env
 * module. The actual env reads + provider-specific config (SMTP host, Resend
 * key) stay in `external-services.ts` / `config-global.server.ts`; t3-env still
 * validates that whichever provider is selected has its required vars.
 *
 * Built on {@link @repo/adapter-config}'s `resolveToggle` so the enabled/backend
 * shape matches every other migration seam. Unlike the telemetry seams, email
 * is opt-in: it stays disabled unless `EMAIL_ENABLED` is explicitly truthy
 * (`defaultEnabled: false`), and there is no "off backend" — disabling routes
 * to the fail-closed `LoggingEmailService`, not a provider.
 */

import { resolveToggle } from '@repo/adapter-config';

type EmailBackend = 'resend' | 'smtp';

/** The env values this resolver reads. Both optional; both raw env strings. */
interface EmailEnv {
  EMAIL_ENABLED?: string;
  EMAIL_PROVIDER?: string;
}

interface EmailConfig {
  /** When false, wire the fail-closed `LoggingEmailService` (no real send). */
  enabled: boolean;
  /** The selected provider backend (only meaningful when `enabled`). */
  backend: EmailBackend;
}

const EMAIL_BACKENDS = ['resend', 'smtp'] as const;

export function resolveEmailConfig(env: EmailEnv): EmailConfig {
  return resolveToggle<EmailBackend>({
    enabledOverride: env.EMAIL_ENABLED,
    backendValue: env.EMAIL_PROVIDER,
    backends: EMAIL_BACKENDS,
    // Email never defaults on — a deploy must set EMAIL_ENABLED truthy. Without
    // an override the seam stays off (LoggingEmailService).
    defaultEnabled: false,
  });
}
