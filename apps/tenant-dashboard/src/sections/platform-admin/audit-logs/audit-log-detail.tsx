'use client';

import { AuditLogDetailDialog } from '../../../components/audit-log/audit-log-detail-dialog';
import { getAuditLogDetail } from './actions';

/**
 * Platform-admin audit log detail: the shared dialog wired to the unscoped
 * (all-tenants) getAuditLogDetail action.
 */

interface AuditLogDetailProps {
  logId: string | null;
  open: boolean;
  onClose: () => void;
}

export function AuditLogDetail({ logId, open, onClose }: AuditLogDetailProps) {
  return (
    <AuditLogDetailDialog
      logId={logId}
      open={open}
      onClose={onClose}
      fetchDetail={getAuditLogDetail}
    />
  );
}
