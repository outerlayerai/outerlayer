/**
 * Environment readiness — the answer to "is this deployment actually able to do
 * its job?", computed from the config it booted with.
 *
 * This exists because `env.ts` sets `skipValidation` on every Vercel build
 * (`!!process.env.VERCEL`), so the zod schema — every `.min(1)`, every refine —
 * is decorative in exactly the environments where being wrong costs something.
 * A deployment missing a required secret boots clean and fails later, quietly
 * and far from the cause: a dashboard that cannot reach GitHub, or an invite
 * that reports success and delivers nothing.
 *
 * Two questions, deliberately kept apart:
 *
 * - `missingRequired` — config the app cannot work without. Non-empty means the
 *   deployment is broken, whether or not anything has noticed yet.
 * - `degraded` — capabilities deliberately switched off or narrowed by config.
 *   Not faults. An operator needs them surfaced anyway, because "email is off"
 *   is indistinguishable from "email is broken" from the outside, and because a
 *   setting that was right for one environment is how the other one breaks.
 *
 * Pure: the caller passes the env in. No `server-only`, no module-level env
 * reads, so it is testable without reloading modules and callable from a boot
 * assertion as easily as from a health route.
 */

/** Truthy spellings accepted for boolean-ish env vars, matching env.ts. */
function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

interface RequiredVar {
  name: string;
  /**
   * `process.env` names tried in order. More than one where `runtimeEnv`
   * accepts a legacy name as a fallback — checking only the new name would
   * report a deployment broken while it runs perfectly on the old one.
   */
  sources: readonly string[];
  /** Minimum length, where the schema demands one (HMAC keys). */
  minLength?: number;
}

/**
 * Config the dashboard cannot function without, in any environment.
 *
 * Mirrors the `.min(1)` server vars in `env.ts`, minus four deliberate
 * omissions — and the `sources` lists must track `runtimeEnv`'s fallbacks, or
 * this check reports phantom breakage:
 *
 * - `DATABASE_URL` is declared required there but has no consumer beyond its
 *   own re-export in `config-global.server.ts`. Failing a deployment over a var
 *   nothing reads would be theatre.
 * - `REPLY_TO_EMAIL` resolves to a hardcoded default in `runtimeEnv`, so it can
 *   never actually be absent.
 * - `GITHUB_APP_*` are capability config, not baseline config — a deployment
 *   with no GitHub App still serves sessions and traces. They surface under
 *   `degraded`, which is the honest severity.
 */
const REQUIRED_VARS: readonly RequiredVar[] = [
  // runtimeEnv: SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY
  { name: 'SUPABASE_SECRET_KEY', sources: ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { name: 'UNKEY_API_KEY', sources: ['UNKEY_API_KEY'] },
  { name: 'API_KEY_PEPPER', sources: ['API_KEY_PEPPER'] },
  { name: 'CRON_SECRET', sources: ['CRON_SECRET'] },
  { name: 'FROM_EMAIL', sources: ['FROM_EMAIL'] },
  { name: 'TOKEN_ENCRYPTION_KEY', sources: ['TOKEN_ENCRYPTION_KEY'], minLength: 32 },
  { name: 'OAUTH_STATE_SECRET', sources: ['OAUTH_STATE_SECRET'], minLength: 32 },
] as const;

/** Every `process.env` name the readiness check consults. */
const READINESS_ENV_KEYS: readonly string[] = [
  ...REQUIRED_VARS.flatMap((spec) => spec.sources),
  'DORA_ENVIRONMENT',
  'EMAIL_ENABLED',
  'EMAIL_RECIPIENT_ALLOWLIST',
  'SIGNUP_EMAIL_ALLOWLIST',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'CLICKHOUSE_HOST',
  'CLICKHOUSE_READ_USER',
  'BILLING_ENABLED',
];

interface DegradedCapability {
  /** What is reduced, in operator terms rather than variable names. */
  capability: string;
  /** Why — the config that caused it, and the practical consequence. */
  reason: string;
}

interface EnvReadiness {
  /** Which environment this deployment believes it is. */
  environment: string;
  /** Required config that is unset or too short. Broken, not merely reduced. */
  missingRequired: string[];
  /** Capabilities switched off or narrowed by config. */
  degraded: DegradedCapability[];
}

export type ReadinessEnv = Record<string, string | undefined>;

function resolve(env: ReadinessEnv, spec: RequiredVar): string | undefined {
  for (const source of spec.sources) {
    if (isSet(env[source])) return env[source];
  }
  return undefined;
}

export function checkEnvReadiness(env: ReadinessEnv): EnvReadiness {
  const missingRequired = REQUIRED_VARS.filter((spec) => {
    const value = resolve(env, spec);
    if (value === undefined) return true;
    return spec.minLength !== undefined && value.length < spec.minLength;
  }).map((spec) => spec.name);

  const degraded: DegradedCapability[] = [];

  // `|| 'false'` / `|| 'true'`: runtimeEnv supplies these defaults, so an unset
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

  if (isSet(env.SIGNUP_EMAIL_ALLOWLIST)) {
    degraded.push({
      capability: 'self-service registration',
      reason: `SIGNUP_EMAIL_ALLOWLIST is set — only ${env.SIGNUP_EMAIL_ALLOWLIST} may register. Invited users are unaffected.`,
    });
  }

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
    missingRequired,
    degraded,
  };
}

/**
 * The env slice {@link checkEnvReadiness} reads, pulled from `process.env`.
 *
 * Reads `process.env` directly rather than the validated `env` module so a
 * deployment whose config is broken can still report *why* — going through
 * `env.ts` would make the reporting path depend on the thing being reported on.
 */
export function readinessEnvFromProcess(): ReadinessEnv {
  return Object.fromEntries(READINESS_ENV_KEYS.map((key) => [key, process.env[key]]));
}
