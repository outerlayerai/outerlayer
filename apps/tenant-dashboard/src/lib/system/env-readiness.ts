/**
 * Config posture — which capabilities this deployment has switched off or
 * narrowed, and what that means in practice.
 *
 * Deliberately NOT a validity check. `env.ts` owns that: its zod schema is the
 * single declaration of what must be present, and it now runs on deployments,
 * so config that is *missing* fails the build rather than being re-described
 * here. A second list of required variables would be one more thing to drift.
 *
 * What zod cannot express is the case where nothing is invalid and the
 * deployment still is not doing what an operator assumes. `EMAIL_ENABLED=false`
 * is a perfectly valid configuration, and it is also the reason an invite
 * reports success and delivers nothing. From outside, "switched off" and
 * "broken" are indistinguishable — that gap is what this reports.
 *
 * Pure: the caller passes the env in, so it is testable without reloading
 * modules.
 */

/** Truthy spellings accepted for boolean-ish env vars, matching env.ts. */
function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

interface DegradedCapability {
  /** What is reduced, in operator terms rather than variable names. */
  capability: string;
  /** Why — the config that caused it, and the practical consequence. */
  reason: string;
}

interface ConfigPosture {
  /** Which environment this deployment believes it is. */
  environment: string;
  /** Capabilities switched off or narrowed by config. Empty means full fat. */
  degraded: DegradedCapability[];
}

export type PostureEnv = Record<string, string | undefined>;

/** Every `process.env` name this reads. */
const POSTURE_ENV_KEYS: readonly string[] = [
  'DORA_ENVIRONMENT',
  'EMAIL_ENABLED',
  'EMAIL_RECIPIENT_ALLOWLIST',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'CLICKHOUSE_HOST',
  'CLICKHOUSE_READ_USER',
  'BILLING_ENABLED',
];

export function checkConfigPosture(env: PostureEnv): ConfigPosture {
  const degraded: DegradedCapability[] = [];

  // `?? 'false'` / `?? 'true'`: runtimeEnv supplies these defaults, so an unset
  // var is not the same as an unset capability.
  const emailEnabled = isTruthy(env.EMAIL_ENABLED ?? 'false');
  const billingEnabled = isTruthy(env.BILLING_ENABLED ?? 'true');

  if (!emailEnabled) {
    degraded.push({
      capability: 'email delivery',
      reason:
        'EMAIL_ENABLED is not truthy — transactional email is intercepted and logged, not sent. Invites report success and deliver nothing.',
    });
  } else if (isSet(env.EMAIL_RECIPIENT_ALLOWLIST)) {
    degraded.push({
      capability: 'email delivery',
      reason: `EMAIL_RECIPIENT_ALLOWLIST is set — mail reaches only ${env.EMAIL_RECIPIENT_ALLOWLIST}. Every other recipient is dropped.`,
    });
  }

  // Optional in the schema on purpose: a deployment without a GitHub App still
  // serves sessions and traces, so its absence is posture, not breakage.
  if (!isSet(env.GITHUB_APP_PRIVATE_KEY) || !isSet(env.GITHUB_APP_WEBHOOK_SECRET)) {
    degraded.push({
      capability: 'GitHub App',
      reason:
        'GITHUB_APP_PRIVATE_KEY or GITHUB_APP_WEBHOOK_SECRET is unset — repository linking and PR-outcome joining fail at call time. Session capture is unaffected.',
    });
  }

  // Isolation posture, not a feature toggle: without the read identity, tenant
  // analytics reads authenticate as the writer, which no ClickHouse row policy
  // covers, so isolation falls back to app-layer WHERE clauses alone.
  if (isSet(env.CLICKHOUSE_HOST) && !isSet(env.CLICKHOUSE_READ_USER)) {
    degraded.push({
      capability: 'ClickHouse tenant isolation',
      reason:
        'CLICKHOUSE_READ_USER is unset while ClickHouse is configured — tenant reads fall back to the writer identity and row policies do not apply.',
    });
  }

  if (!billingEnabled) {
    degraded.push({
      capability: 'billing',
      reason:
        'BILLING_ENABLED is falsy — Stripe is not called and every tenant stays on its current tier.',
    });
  }

  return {
    // runtimeEnv defaults this to 'production'; mirror it so an unset var reads
    // the same here as it does everywhere else in the app.
    environment: env.DORA_ENVIRONMENT ?? 'production',
    degraded,
  };
}

/**
 * The env slice {@link checkConfigPosture} reads, pulled from `process.env`
 * rather than the validated `env` module: posture is about raw presence, and
 * `env` has already applied fallbacks that would mask it.
 */
export function postureEnvFromProcess(): PostureEnv {
  return Object.fromEntries(POSTURE_ENV_KEYS.map((key) => [key, process.env[key]]));
}
