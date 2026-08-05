'use server';

import type { ServerActionResponse } from '../../../types/server-action';
import type {
  ListAuditLogsParams,
  AuditLogListItem,
  AuditLogDetail,
  PaginatedResponse,
} from '../../../types/platform-admin';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';
import { createAuditLogViewerService } from '../services';

/**
 * List audit log entries with optional filters.
 * Requires platform admin role.
 *
 * Delegates to AuditLogViewerService for business logic.
 */
export async function listAuditLogs(
  params: ListAuditLogsParams
): Promise<ServerActionResponse<PaginatedResponse<AuditLogListItem>>> {
  return await withPlatformAdminCheck(async () => {
    const service = createAuditLogViewerService();
    return await service.list(params);
  });
}

/**
 * Get full details of a single audit log entry.
 * Requires platform admin role.
 *
 * Delegates to AuditLogViewerService for business logic.
 */
export async function getAuditLogDetail(
  logId: string
): Promise<ServerActionResponse<AuditLogDetail>> {
  return await withPlatformAdminCheck(async () => {
    const service = createAuditLogViewerService();
    return await service.getDetail(logId);
  });
}
