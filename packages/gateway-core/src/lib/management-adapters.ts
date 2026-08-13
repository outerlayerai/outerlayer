/**
 * Gateway-side adapters for `@repo/org-management-service`'s injected
 * seams (`MembershipServiceConfig`). The dashboard wires its own richer
 * implementations (Resend, Stripe-aware billing, EE app-role assignment);
 * the gateway has no equivalents for several of these today, so this module
 * is also the honest record of what a management-API-key invite/role/remove
 * call can and cannot do until those facilities land on the gateway:
 *
 *   - EmailService: NO provider wired. Every send fails with a clear error.
 *     `MembershipService` already degrades gracefully on an email failure
 *     (the membership/invite row still commits; the caller is told to
 *     resend) — but a resend hits the same unconfigured adapter, so an
 *     invite minted through the gateway today can never successfully email
 *     its recipient. The membership row exists; the dashboard's own
 *     "Resend invite" (Resend-backed) is the only way to actually deliver
 *     the email until the gateway gets a mail provider.
 *   - RateLimitService: reuses the injected `gtx.rateLimiter` (the same
 *     Unkey-backed, fail-open limiter every other /v1/* write route uses),
 *     keyed by the caller-supplied identifier directly.
 *   - EntitlementGate: `max_users` / `app_level_roles` are dashboard-only
 *     keys — no shared `@repo/tier-config` matrix exists for them (unlike
 *     `max_api_keys` / `max_apps`, which the gateway already tier-gates).
 *     This adapter honors an explicit `tenant_entitlement_override` row
 *     (the same override table the dashboard consults first) but has no
 *     tier matrix to fall back to, so an org with no override is treated as
 *     unlimited/allowed. Net effect: inviting via the gateway does not
 *     enforce the dashboard's per-tier seat cap or the `app_level_roles`
 *     entitlement — only an explicit platform-admin override is honored.
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
import type { Env } from '../types';
import type { OpenAPIVariables } from '../openapi/middleware';
import type { Json } from '@repo/db-types';
import type { SystemAdminClient } from './system-client';

type ManagementAppContext = Context<{ Bindings: Env; Variables: OpenAPIVariables }>;

/**
 * No email provider is wired into the gateway. Every send fails with a
 * stable, non-throwing error so `MembershipService`'s existing
 * "membership created but email failed, please resend" handling takes over
 * — the caller sees an honest signal rather than a silent no-op or a
 * fabricated success.
 */
export function buildManagementEmailService(): EmailService {
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

interface EntitlementOverrideRow {
  entitlement_key: string;
  value: unknown;
}

async function readOverride(
  admin: SystemAdminClient,
  tenantId: string,
  key: string,
): Promise<unknown> {
  const { data, error } = await admin
    .from('tenant_entitlement_override')
    .select('entitlement_key, value')
    .eq('tenant_id', tenantId)
    .eq('entitlement_key', key)
    .maybeSingle();
  if (error) {
    console.error('[management-adapters] entitlement override read failed', {
      tenantId,
      key,
      error: error.message,
    });
    return undefined;
  }
  return (data as EntitlementOverrideRow | null)?.value;
}

/**
 * `max_users` / `app_level_roles` have no shared tier matrix (see module
 * doc) — this only ever consults an explicit override, defaulting open
 * (unlimited / allowed) absent one.
 */
export function buildManagementEntitlementGate(admin: SystemAdminClient): EntitlementGate {
  return {
    async checkLimit(tenantId, key, currentCount) {
      const override = await readOverride(admin, tenantId, key);
      if (typeof override === 'number' && Number.isFinite(override)) {
        if (override < 0) return { allowed: true, limit: override, currentCount };
        return { allowed: currentCount < override, limit: override, currentCount };
      }
      return { allowed: true, limit: -1, currentCount };
    },
    async canAccess(tenantId, key) {
      const override = await readOverride(admin, tenantId, key);
      if (typeof override === 'boolean') return override;
      return true;
    },
    buildDeniedInfo(key, checkResult) {
      return {
        entitlement: key,
        limit: checkResult?.limit,
        currentCount: checkResult?.currentCount,
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
