import 'server-only';

import { AuditLogViewerService } from '@/lib/system/audit-log/audit-log-viewer-service';
import { auditLogRowsToCsv } from '@/lib/system/audit-log/audit-log-csv';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import type {
  ListAuditLogsParams,
  AuditLogListItem,
  AuditLogDetail,
  PaginatedResponse,
} from '@/types/platform-admin';

/**
 * `AuditLogViewerService` stays legacy-owned — shared, unmodified, with the
 * platform-admin viewer (not absorbed into any one tenant slice) — so
 * new-world code reaches it through this narrow crossing rather than
 * importing the legacy service tree directly. Reads use the service-role
 * client so actor emails resolve even for members who have since been
 * removed (the profile RLS policy only exposes ACTIVE same-tenant members —
 * an audit trail must outlive its actors).
 */
function service(): AuditLogViewerService {
  return new AuditLogViewerService({ db: createSupabaseAdminClient() });
}

export async function listAuditLogEntries(
  params: ListAuditLogsParams,
): Promise<{ data?: PaginatedResponse<AuditLogListItem>; error?: string }> {
  return service().list(params);
}

export async function getAuditLogEntryDetail(
  logId: string,
  opts: { tenantId?: string } = {},
): Promise<{ data?: AuditLogDetail; error?: string }> {
  return service().getDetail(logId, opts);
}

export async function listAuditLogEntriesForExport(
  tenantId: string,
): Promise<{ data?: AuditLogDetail[]; error?: string }> {
  return service().listForExport(tenantId);
}

export { auditLogRowsToCsv };
