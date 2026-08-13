/**
 * Gateway-side adapters for `@repo/org-management-service`'s injected
 * seams (`MembershipServiceConfig`). The dashboard wires its own richer
 * implementations (Resend, Stripe-aware billing, EE app-role assignment);
 * the gateway has no equivalents for several of these today, so this module
 * is also the honest record of what a management-API-key invite/role/remove
 * call can and cannot do until those facilities land on the gateway:
 *
 *   - EmailService: Resend-backed (`management-email.ts`), rendering the
 *     same `@repo/transactional` React Email templates the dashboard uses,
 *     when `RESEND_API_KEY` + `FROM_EMAIL` are configured on the
 *     deployment. Sends via a raw `fetch` to Resend's REST API rather than
 *     the `resend` npm SDK, keeping the Workers bundle to just the
 *     templates + `@react-email/render`. Unset env (the default on a fresh
 *     self-host deploy) keeps the old fail-closed behavior: every send
 *     returns a clear error and `MembershipService` degrades gracefully
 *     (the membership/invite row still commits; the caller is told to
 *     resend) — a resend against an unconfigured adapter hits the same
 *     error, so the dashboard's own "Resend invite" is the only delivery
 *     path until Resend is wired.
 *   - RateLimitService: reuses the injected `gtx.rateLimiter` (the same
 *     Unkey-backed, fail-open limiter every other /v1/* write route uses),
 *     keyed by the caller-supplied identifier directly.
 *   - EntitlementGate: `max_users` and `app_level_roles` are both present in
 *     `@repo/tier-config`'s shared matrix (alongside `max_api_keys` /
 *     `max_apps`), so this adapter resolves them through
 *     `@repo/entitlements`'s override → tier-matrix → hobby-default chain —
 *     the same resolver the gateway's other quota-gated /v1/* routes and the
 *     dashboard's `EntitlementService` use — with the self-host generous
 *     default applied via `isSelfHostGateway`. A gateway-minted invite now
 *     enforces the tenant's per-tier seat cap and `app_level_roles`
 *     entitlement exactly as the dashboard does; an explicit
 *     `tenant_entitlement_override` row still wins over the tier default.
 *   - AppRoleAssigner: per-app role assignment on invite requires the EE
 *     custom-role/app-access resolution the dashboard's own
 *     `AppMemberRoleService` performs; the gateway has no such surface.
 *     Requesting `appRoles` on a gateway invite fails that (and only that)
 *     part of the operation closed — the invite itself still succeeds.
 *   - AuditLogWriter: writes directly to `public.audit_log` via the admin
 *     client, mirroring the dashboard's `AuditLogService` (same columns,
 *     `actor_type: 'api_key'`).
 *   - RequestContext: built from the live Hono request (`CF-Connecting-IP` /
 *     `X-Forwarded-For`, `User-Agent`), no `next/headers` anywhere.
 */

import type { Context } from 'hono';
import type {
  AppRoleAssigner,
  AuditLogWriter,
  EmailService,
  EntitlementGate,
  Logger,
  RateLimitService,
  RequestContext,
  StripeService,
} from '@repo/org-management-service';
import {
  resolveBooleanEntitlement as resolveSharedBoolean,
  resolveNumericLimit as resolveSharedNumericLimit,
  quotaCheck,
} from '@repo/entitlements';
import { resolveSelfHostBoolean, SELF_HOST_NUMERIC_LIMIT } from '@repo/ee-license';
import {
  TIER_IDS,
  UNLIMITED,
  NUMERIC_ENTITLEMENTS,
  BOOLEAN_ENTITLEMENTS,
  type TierId,
  type NumericEntitlementKey,
  type BooleanEntitlementKey,
} from '@repo/tier-config';
import type { Env } from '../types';
import type { OpenAPIVariables } from '../openapi/middleware';
import type { Json } from '@repo/db-types';
import type { SystemAdminClient } from './system-client';
import { isSelfHostGateway } from './entitlements';
import { buildResendManagementEmailService } from './management-email';

type ManagementAppContext = Context<{ Bindings: Env; Variables: OpenAPIVariables }>;

/**
 * Resend-backed when `RESEND_API_KEY` + `FROM_EMAIL` are configured (see
 * `management-email.ts`); otherwise every send fails with a stable,
 * non-throwing error so `MembershipService`'s existing "membership created
 * but email failed, please resend" handling takes over — the caller sees an
 * honest signal rather than a silent no-op or a fabricated success.
 */
export function buildManagementEmailService(env: Env): EmailService {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    return {
      async sendEmail() {
        return {
          error: new Error(
            'No email provider is configured on this gateway deployment — the membership/invite record was written, but no email was sent',
          ),
        };
      },
    };
  }
  return buildResendManagementEmailService({
    resendApiKey: env.RESEND_API_KEY,
    fromEmail: env.FROM_EMAIL,
    replyToEmail: env.REPLY_TO_EMAIL,
  });
}

/**
 * Fixed, generous rate limit for management-API-key write operations
 * (invite send / resend). Reuses the same injected, fail-open limiter every
 * other /v1/* write route uses (`gtx.rateLimiter`) — a limiter outage never
 * blocks a management call, matching the rest of the gateway.
 */
const MANAGEMENT_RATE_LIMIT = {
  namespace: 'management-api-invite',
  limit: 5,
  durationMs: 60_000,
  cost: 1,
} as const;

export function buildManagementRateLimitService(c: ManagementAppContext): RateLimitService {
  return {
    async limit(identifier: string) {
      const outcome = await c.get('gtx').rateLimiter.check(MANAGEMENT_RATE_LIMIT, identifier);
      return { success: outcome.allowed };
    },
  };
}

/**
 * No Stripe surface is wired into the gateway's management-API path — none
 * of `MembershipService`'s current methods call any `StripeService` method
 * (the config field is accepted for constructor-shape parity only, per the
 * package's own doc comment). Every method throws if ever invoked, so a
 * future caller that starts depending on it fails loudly instead of
 * silently no-op'ing.
 */
export function buildManagementStripeService(): StripeService {
  const unimplemented = (): never => {
    throw new Error('Stripe is not available to management-API-key operations on the gateway');
  };
  return {
    createCustomer: unimplemented,
    retrieveCustomer: unimplemented,
    deleteCustomer: unimplemented,
    retrieveSubscription: unimplemented,
    updateSubscription: unimplemented,
  };
}

function isNumericEntitlementKey(key: string): key is NumericEntitlementKey {
  return key in NUMERIC_ENTITLEMENTS;
}

function isBooleanEntitlementKey(key: string): key is BooleanEntitlementKey {
  return key in BOOLEAN_ENTITLEMENTS;
}

/**
 * Lowest tier (by `@repo/tier-config` matrix order) that grants a numeric
 * key a higher-than-hobby limit, or a boolean key `true`. Mirrors the
 * dashboard's `getRequiredTierForFeature` (`lib/app-shell/entitlement-denied.ts`)
 * restricted to the keys that actually live in the shared matrix — the
 * dashboard's version also covers its own display-only categorical keys,
 * which the management API never asks about.
 */
function requiredTierForNumericKey(key: NumericEntitlementKey): TierId {
  const matrix = NUMERIC_ENTITLEMENTS[key];
  const lowest = TIER_IDS[0] ?? 'hobby';
  const lowestValue = matrix[lowest];
  for (const tier of TIER_IDS.slice(1)) {
    const value = matrix[tier];
    if (value === UNLIMITED || value > lowestValue) return tier;
  }
  return lowest;
}

function requiredTierForBooleanKey(key: BooleanEntitlementKey): TierId {
  const matrix = BOOLEAN_ENTITLEMENTS[key];
  for (const tier of TIER_IDS) {
    if (matrix[tier]) return tier;
  }
  return TIER_IDS[TIER_IDS.length - 1] ?? 'enterprise';
}

/**
 * Resolves `max_users` / `app_level_roles` (and any other key that lands in
 * `@repo/tier-config`'s shared matrix) through the same override → tier →
 * hobby-default chain as the gateway's other quota-gated /v1/* routes and
 * the dashboard's `EntitlementService`. A key the shared matrix doesn't
 * know about (there are none the management API asks about today, but the
 * `EntitlementGate` interface accepts an arbitrary string) resolves open —
 * unlimited / allowed — rather than fail closed, so a future key added to
 * `MembershipService` without a matching tier-config entry doesn't start
 * blocking invites on a KeyError-shaped surprise.
 */
export function buildManagementEntitlementGate(admin: SystemAdminClient, env: Env): EntitlementGate {
  return {
    async checkLimit(tenantId, key, currentCount) {
      if (!isNumericEntitlementKey(key)) {
        return { allowed: true, limit: UNLIMITED, currentCount };
      }
      const limit = isSelfHostGateway(env)
        ? SELF_HOST_NUMERIC_LIMIT
        : await resolveSharedNumericLimit(admin, tenantId, key);
      const { allowed } = quotaCheck(currentCount, limit);
      if (allowed) return { allowed: true, limit, currentCount };
      return { allowed: false, limit, currentCount, requiredTier: requiredTierForNumericKey(key) };
    },
    async canAccess(tenantId, key) {
      if (!isBooleanEntitlementKey(key)) return true;
      if (isSelfHostGateway(env)) {
        // No EE key has a gateway license-resolution surface today (see
        // `entitlements.ts`'s self-host note) — licensed: false is the
        // generous-default half, matching every other self-host boolean
        // resolution in this gateway.
        return resolveSelfHostBoolean(key, false);
      }
      return resolveSharedBoolean(admin, tenantId, key);
    },
    buildDeniedInfo(key, checkResult) {
      const requiredTier = isNumericEntitlementKey(key)
        ? requiredTierForNumericKey(key)
        : isBooleanEntitlementKey(key)
          ? requiredTierForBooleanKey(key)
          : undefined;
      return {
        entitlement: key,
        limit: checkResult?.limit,
        currentCount: checkResult?.currentCount,
        requiredTier: checkResult?.requiredTier ?? requiredTier,
      };
    },
  };
}

/**
 * Per-app role assignment needs the EE custom-role / app-access resolution
 * the dashboard's `AppMemberRoleService` performs — no gateway equivalent
 * exists. Fails closed with a clear, per-assignment error; the caller
 * (`MembershipService.sendInvite`) already surfaces this as "invited but
 * app roles failed, assign manually" without rolling back the invite.
 */
export function buildManagementAppRoleAssigner(): AppRoleAssigner {
  return {
    async bulkAssign(_tenantId, _actorId, input) {
      return {
        success: false,
        error: 'Per-app role assignment on invite is not supported via the management API yet',
        data: { errors: input.assignments.map((a) => ({ appId: a.appId })) },
      };
    },
  };
}

export function buildManagementAuditLogWriter(admin: SystemAdminClient): AuditLogWriter {
  return {
    async create(entry) {
      const { error } = await admin.from('audit_log').insert({
        tenant_id: entry.tenantId,
        actor_id: null,
        actor_type: 'api_key',
        actor_label: entry.actorId,
        action_type: entry.actionType,
        target_type: entry.targetType,
        target_id: entry.targetId,
        target_identifier: entry.targetIdentifier ?? null,
        details: (entry.details ?? null) as Json,
        after_state: (entry.afterState ?? null) as Json,
      });
      if (error) {
        console.error('[management-adapters] audit_write_failed', {
          tenantId: entry.tenantId,
          actionType: entry.actionType,
          error: error.message,
        });
      }
    },
  };
}

/** Best-effort IP/user-agent from the live request — no `next/headers` seam exists on the gateway. */
export function buildManagementRequestContext(c: ManagementAppContext): () => Promise<RequestContext> {
  return async () => {
    const forwardedFor = c.req.header('X-Forwarded-For');
    const ipAddress =
      c.req.header('CF-Connecting-IP') ??
      forwardedFor?.split(',')[0]?.trim() ??
      null;
    return {
      ipAddress: ipAddress || null,
      userAgent: c.req.header('User-Agent') ?? null,
      requestId: c.req.header('X-Request-Id') ?? null,
    };
  };
}

export function buildManagementLogger(): Logger {
  return {
    async error(error, metadata) {
      console.error('[management-api]', error, metadata);
    },
  };
}
