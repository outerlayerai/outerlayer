import "server-only";

/**
 * AuditLogViewerService - Business logic for viewing audit logs.
 * Dependencies are injected through the constructor so the service is testable.
 *
 * Note: This is separate from AuditLogService which handles creating entries.
 * This service handles listing and viewing audit log entries.
 *
 * Two callers, one implementation:
 *  - the internal platform-admin viewer (service-role db, no tenantId — all rows)
 *  - the tenant Settings -> Audit log viewer (tenantId forced from the caller's
 *    JWT, so an org only ever reads its own trail)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ListAuditLogsParams,
  AuditLogListItem,
  AuditLogDetail,
  AuditActorType,
  PaginatedResponse,
} from '@/types/platform-admin';

interface AuditLogViewerServiceDeps {
  db: SupabaseClient;
}

/** Live profile lookup shape for actor display. */
type ActorProfile = { email: string; name: string | null };

export class AuditLogViewerService {
  private db: SupabaseClient;

  constructor(deps: AuditLogViewerServiceDeps) {
    this.db = deps.db;
  }

  /**
   * Resolve live profiles for a set of actor ids in one query.
   *
   * audit_log.actor_id is a frozen, FK-less pointer (rows never mutate — the
   * hash chain covers them), so there is no PostgREST embed; actors whose
   * profile is gone resolve to nothing and the caller falls back to
   * the denormalized actor_label. Lookup failures degrade the display, never
   * the listing.
   */
  private async resolveActorProfiles(
    actorIds: (string | null)[]
  ): Promise<Map<string, ActorProfile>> {
    const ids = [...new Set(actorIds.filter((id): id is string => !!id))];
    if (ids.length === 0) {
      return new Map();
    }

    const { data, error } = await this.db
      .from('profile')
      .select('id, email, name')
      .in('id', ids);

    if (error || !data) {
      return new Map();
    }

    return new Map(data.map((p) => [p.id, { email: p.email, name: p.name }]));
  }

  /**
   * List audit log entries with optional filters.
   */
  async list(
    params: ListAuditLogsParams
  ): Promise<{ data?: PaginatedResponse<AuditLogListItem>; error?: string }> {
    const {
      page = 1,
      pageSize = 25,
      tenantId,
      actorId,
      actionType,
      targetType,
      targetId,
      startDate,
      endDate,
    } = params;

    const effectivePageSize = Math.min(pageSize, 100);
    const offset = (page - 1) * effectivePageSize;

    let query = this.db
      .from('audit_log')
      .select(
        `
        id,
        actor_id,
        actor_type,
        actor_label,
        tenant_id,
        action_type,
        target_type,
        target_id,
        target_identifier,
        details,
        created_at
      `,
        { count: 'exact' }
      );

    // Tenant scoping: forced by the tenant-facing caller from the session
    // JWT (never client input). Platform-scoped rows have tenant_id NULL,
    // so they can never match.
    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }

    if (actorId) {
      query = query.eq('actor_id', actorId);
    }

    if (actionType) {
      query = query.eq('action_type', actionType);
    }

    if (targetType) {
      query = query.eq('target_type', targetType);
    }

    if (targetId) {
      query = query.eq('target_id', targetId);
    }

    if (startDate) {
      query = query.gte('created_at', startDate);
    }

    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    query = query.order('created_at', { ascending: false });
    query = query.range(offset, offset + effectivePageSize - 1);

    const { data: logs, error, count } = await query;

    if (error) {
      return { error: `Failed to list audit logs: ${error.message}` };
    }

    const profiles = await this.resolveActorProfiles((logs || []).map((l) => l.actor_id));

    const items: AuditLogListItem[] = (logs || []).map((log) => {
      const profile = log.actor_id ? profiles.get(log.actor_id) ?? null : null;
      const details = log.details as Record<string, unknown> | null;

      // Create a preview of the details
      let detailsPreview: string | null = null;
      if (details) {
        const preview = JSON.stringify(details);
        detailsPreview = preview.length > 100 ? `${preview.slice(0, 97)}...` : preview;
      }

      return {
        id: log.id,
        actor_id: log.actor_id,
        actor_type: log.actor_type as AuditActorType,
        actor_label: log.actor_label,
        actor_email: profile?.email ?? null,
        actor_name: profile?.name ?? null,
        tenant_id: log.tenant_id,
        action_type: log.action_type,
        target_type: log.target_type,
        target_id: log.target_id,
        target_identifier: log.target_identifier,
        created_at: log.created_at,
        details_preview: detailsPreview,
      };
    });

    const total = count || 0;
    const totalPages = Math.ceil(total / effectivePageSize);

    return {
      data: {
        items,
        total,
        page,
        pageSize: effectivePageSize,
        totalPages,
      },
    };
  }

  /**
   * Get full details of a single audit log entry.
   *
   * `tenantId` (when given) scopes the lookup to that tenant's trail — a
   * tenant caller can never fetch another tenant's (or a platform) entry by
   * guessing its id.
   */
  async getDetail(
    logId: string,
    opts: { tenantId?: string } = {}
  ): Promise<{ data?: AuditLogDetail; error?: string }> {
    let query = this.db
      .from('audit_log')
      .select(
        `
        id,
        actor_id,
        actor_type,
        actor_label,
        tenant_id,
        ip_address,
        user_agent,
        request_id,
        action_type,
        target_type,
        target_id,
        target_identifier,
        details,
        before_state,
        after_state,
        created_at
      `
      )
      .eq('id', logId);

    if (opts.tenantId) {
      query = query.eq('tenant_id', opts.tenantId);
    }

    const { data: log, error } = await query.single();

    if (error || !log) {
      return { error: 'Audit log entry not found' };
    }

    const profiles = await this.resolveActorProfiles([log.actor_id]);

    return { data: this.toDetail(log, profiles) };
  }

  /**
   * Full-trail fetch for a tenant's CSV export: chronological, paged
   * internally (PostgREST caps a single range), actors resolved in one pass.
   * The page loop is bounded far above human-action volume as a safety valve;
   * hitting the bound truncates the oldest-first export and is reported.
   */
  async listForExport(tenantId: string): Promise<{ data?: AuditLogDetail[]; error?: string }> {
    const PAGE_SIZE = 1000;
    const MAX_ROWS = 50000;
    const raw: Record<string, unknown>[] = [];

    for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
      const { data, error } = await this.db
        .from('audit_log')
        .select(
          `
        id,
        actor_id,
        actor_type,
        actor_label,
        tenant_id,
        ip_address,
        user_agent,
        request_id,
        action_type,
        target_type,
        target_id,
        target_identifier,
        details,
        before_state,
        after_state,
        created_at
      `
        )
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        return { error: `Failed to export audit logs: ${error.message}` };
      }

      raw.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) {
        break;
      }
    }

    const profiles = await this.resolveActorProfiles(
      raw.map((l) => l.actor_id as string | null)
    );

    return { data: raw.map((log) => this.toDetail(log, profiles)) };
  }

  private toDetail(
    log: Record<string, unknown>,
    profiles: Map<string, ActorProfile>
  ): AuditLogDetail {
    const actorId = (log.actor_id as string | null) ?? null;
    const profile = actorId ? profiles.get(actorId) ?? null : null;

    return {
      id: log.id as string,
      actor_id: actorId,
      actor_type: log.actor_type as AuditActorType,
      actor_label: (log.actor_label as string | null) ?? null,
      actor_email: profile?.email ?? null,
      actor_name: profile?.name ?? null,
      tenant_id: (log.tenant_id as string | null) ?? null,
      ip_address: (log.ip_address as string | null) ?? null,
      user_agent: (log.user_agent as string | null) ?? null,
      request_id: (log.request_id as string | null) ?? null,
      action_type: log.action_type as AuditLogDetail['action_type'],
      target_type: log.target_type as AuditLogDetail['target_type'],
      target_id: (log.target_id as string | null) ?? null,
      target_identifier: (log.target_identifier as string | null) ?? null,
      details: log.details as Record<string, unknown> | null,
      before_state: log.before_state as Record<string, unknown> | null,
      after_state: log.after_state as Record<string, unknown> | null,
      created_at: log.created_at as string,
    };
  }
}
