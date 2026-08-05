'use client';

import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import Iconify from '@/components/iconify';
import {
  AuditLogTable,
  type AuditLogFilterOption,
} from '@/components/audit-log/audit-log-table';
import { AuditLogDetailDialog } from '@/components/audit-log/audit-log-detail-dialog';
import {
  listAuditLogAction,
  getAuditLogDetailAction,
  exportAuditLogAction,
} from '../actions';
import type { ServerActionResponse } from '@/types/server-action';
import type { ActionType, TargetType, AuditLogListItem, PaginatedResponse } from '@/types/platform-admin';

/**
 * Tenant Settings -> Audit log: the organization's own access-control trail.
 * The shared table/dialog wired to the tenant-scoped actions — only rows with
 * this org's tenant_id ever come back, so the filter vocabulary below is the
 * tenant-relevant subset (membership + roles + denied attempts).
 */

const ACTION_TYPES: AuditLogFilterOption<ActionType>[] = [
  { value: '', label: 'All Actions' },
  { value: 'member_invited', label: 'Member Invited' },
  { value: 'invite_resent', label: 'Invite Resent' },
  { value: 'member_role_changed', label: 'Member Role Changed' },
  { value: 'member_removed', label: 'Member Removed' },
  { value: 'custom_role_created', label: 'Custom Role Created' },
  { value: 'custom_role_updated', label: 'Custom Role Updated' },
  { value: 'custom_role_deleted', label: 'Custom Role Deleted' },
  { value: 'custom_role_assigned', label: 'Custom Role Assigned' },
  { value: 'custom_role_unassigned', label: 'Custom Role Unassigned' },
  { value: 'app_role_assigned', label: 'App Role Assigned' },
  { value: 'app_role_updated', label: 'App Role Updated' },
  { value: 'app_role_revoked', label: 'App Role Revoked' },
  { value: 'app_roles_bulk_assigned', label: 'App Roles Bulk Assigned' },
  { value: 'app_scope_changed', label: 'App Scope Changed' },
  { value: 'api_key_created', label: 'API Key Created' },
  { value: 'api_key_updated', label: 'API Key Updated' },
  { value: 'api_key_deleted', label: 'API Key Deleted' },
  { value: 'permission_denied', label: 'Permission Denied' },
];

const TARGET_TYPES: AuditLogFilterOption<TargetType>[] = [
  { value: '', label: 'All Targets' },
  { value: 'membership', label: 'Membership' },
  { value: 'custom_role', label: 'Custom Role' },
  { value: 'app_member_role', label: 'App Role' },
  { value: 'api_key', label: 'API Key' },
  { value: 'permission', label: 'Permission' },
];

/**
 * Flattens an `authorizedAction`'s wrapper ok/error into the plain
 * `{data?, error?}` shape `AuditLogTable`/`AuditLogDetailDialog` already
 * take — the same shape the underlying `ee/features/audit-log/service`
 * functions already return, so a denial is the only branch to translate.
 */
function unwrapAuditAction<T>(
  result: { ok: true; data: { data?: T; error?: string } } | { ok: false; error: { message: string } }
): ServerActionResponse<T> {
  if (!result.ok) return { error: result.error.message };
  return result.data;
}

interface AuditLogSettingsProps {
  /** First page, seeded by a React Server Component (RSC) — the settings page
   *  reads `searchParams` server-side.
   *  Omit for the fully client-fetched fallback (e.g. a denied-permission
   *  render passes only `initialError`). */
  initialData?: PaginatedResponse<AuditLogListItem>;
  initialError?: string;
  initialFilters?: {
    page?: number;
    pageSize?: number;
    actionType?: ActionType | '';
    targetType?: TargetType | '';
    fromDate?: string;
    toDate?: string;
  };
}

export default function AuditLogSettings({ initialData, initialError, initialFilters }: AuditLogSettingsProps) {
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleViewDetail = (logId: string) => {
    setSelectedLogId(logId);
    setDetailOpen(true);
  };

  const handleCloseDetail = () => {
    setDetailOpen(false);
    setSelectedLogId(null);
  };

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);

    const result = unwrapAuditAction(await exportAuditLogAction({}));
    if (result?.data) {
      const blob = new Blob([result.data.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.data.filename;
      link.click();
      URL.revokeObjectURL(url);
    } else {
      setExportError(result?.error ?? 'Failed to export audit logs');
    }

    setExporting(false);
  };

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}
      >
        <Box>
          <Typography variant="h6">Audit log</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            Every access-control change in your organization: invites, role
            changes, member removals, API key changes, and denied attempts.
            Entries are write-once and tamper-evident; nobody can edit or
            delete them.
          </Typography>
          {exportError && (
            <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
              {exportError}
            </Typography>
          )}
        </Box>
        <Button
          variant="outlined"
          size="small"
          onClick={handleExport}
          disabled={exporting}
          startIcon={<Iconify icon="mdi:download" />}
          sx={{ flexShrink: 0 }}
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </Stack>

      <AuditLogTable
        fetchPage={(params) => listAuditLogAction(params).then(unwrapAuditAction)}
        actionTypes={ACTION_TYPES}
        targetTypes={TARGET_TYPES}
        onViewDetail={handleViewDetail}
        emptyLabel="No audit entries yet"
        initialData={initialData}
        initialError={initialError}
        initialFilters={initialFilters}
      />

      <AuditLogDetailDialog
        logId={selectedLogId}
        open={detailOpen}
        onClose={handleCloseDetail}
        fetchDetail={(logId) => getAuditLogDetailAction({ logId }).then(unwrapAuditAction)}
      />
    </Box>
  );
}
