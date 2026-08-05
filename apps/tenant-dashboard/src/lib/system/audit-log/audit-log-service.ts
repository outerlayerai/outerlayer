import "server-only";

import type { SupabaseClient } from '@supabase/supabase-js';
import { logServerError } from '@/lib/adapters/server-error-log';

/**
 * AuditLogService - the single write seam for the consolidated audit log
 * (public.audit_log).
 *
 * One immutable, tamper-evident trail for platform-admin actions and
 * tenant-visible access-control changes, with a polymorphic actor. Rows are
 * written with the service-role client (RLS permits inserts from service_role
 * only), are immutable once written (block_update / block_delete policies),
 * and are linked into a hash chain by a database trigger.
 *
 * Defaults keep platform callers simple: omitting actorType/tenantId records
 * a human, platform-scoped event. Request context (IP, user agent, request
 * id) is captured automatically from the current request when available.
 *
 * NOTE: membership-lifecycle events (invite, role change, removal) are NOT
 * written through this seam — they are written atomically inside their
 * transaction functions (03-functions-transactions.sql) so the mutation and
 * its audit row commit or roll back together.
 */

type AuditActorType = 'human' | 'gateway' | 'api_key' | 'system' | 'webhook';

interface AuditRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Best-effort request context from the current Next.js request scope.
 * Returns nulls outside a request (background jobs, tests).
 */
export async function captureRequestContext(): Promise<AuditRequestContext> {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    const forwardedFor = h.get('x-forwarded-for');
    return {
      ipAddress: forwardedFor?.split(',')[0]?.trim() || h.get('x-real-ip') || null,
      userAgent: h.get('user-agent') ?? null,
      requestId: h.get('x-vercel-id') ?? h.get('x-request-id') ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null, requestId: null };
  }
}

export interface AuditLogEntry {
  /** Human actor profile id; null/omitted for machine actors. */
  actorId?: string | null;
  /** Defaults to 'human'. */
  actorType?: AuditActorType;
  /** Non-human actor handle (api key id, 'gateway', ...). */
  actorLabel?: string | null;
  /** Omit/null for platform-scoped events; set for a tenant's trail. */
  tenantId?: string | null;
  actionType: string;
  targetType: string;
  targetId?: string | null;
  /** Human-readable target (email, role name) that survives target deletion. */
  targetIdentifier?: string | null;
  details?: Record<string, unknown> | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  /** Explicit request context; when omitted it is captured from the request. */
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

interface AuditLogServiceDeps {
  /** Service-role client: the audit_log insert policy is service_role-only. */
  db: SupabaseClient;
}

export class AuditLogService {
  private db: SupabaseClient;

  constructor(deps: AuditLogServiceDeps) {
    this.db = deps.db;
  }

  async create(entry: AuditLogEntry): Promise<void> {
    // Audit failures (error responses AND thrown transport errors) must not
    // break the primary operation. They ARE loud: `audit_write_failed` is a
    // structured server log line that ops alerting keys on — an audit trail
    // that silently stops recording is itself an incident.
    try {
      const context = await captureRequestContext();
      const { error } = await this.db.from('audit_log').insert({
        tenant_id: entry.tenantId ?? null,
        actor_id: entry.actorId ?? null,
        actor_type: entry.actorType ?? 'human',
        actor_label: entry.actorLabel ?? null,
        action_type: entry.actionType,
        target_type: entry.targetType,
        target_id: entry.targetId ?? null,
        target_identifier: entry.targetIdentifier ?? null,
        details: entry.details ?? null,
        before_state: entry.beforeState ?? null,
        after_state: entry.afterState ?? null,
        ip_address: entry.ipAddress ?? context.ipAddress ?? null,
        user_agent: entry.userAgent ?? context.userAgent ?? null,
        request_id: entry.requestId ?? context.requestId ?? null,
      });

      if (error) {
        await this.reportFailure(entry, error.message);
      }
    } catch (e) {
      await this.reportFailure(entry, e instanceof Error ? e.message : String(e));
    }
  }

  private async reportFailure(entry: AuditLogEntry, message: string): Promise<void> {
    try {
      await logServerError(new Error('audit_write_failed'), {
        actionType: entry.actionType,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        tenantId: entry.tenantId ?? null,
        error: message,
      });
    } catch {
      // Last resort: the logger itself failed; never propagate.
      console.error('[Audit] audit_write_failed and logger unavailable:', message);
    }
  }
}
