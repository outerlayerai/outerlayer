'use client';

import {
  AuditLogTable,
  type AuditLogFilterOption,
} from '../../../components/audit-log/audit-log-table';
import { listAuditLogs } from './actions';
import type { ActionType, TargetType } from '../../../types/platform-admin';

/**
 * Platform-admin audit log list: the shared table wired to the unscoped
 * (all-tenants) listAuditLogs action. Internal tool — every row in the trail
 * is visible, platform-scoped and tenant-scoped alike.
 */

const ACTION_TYPES: AuditLogFilterOption<ActionType>[] = [
  { value: '', label: 'All Actions' },
  { value: 'org_delete', label: 'Organization Delete' },
  { value: 'user_delete', label: 'User Delete' },
  { value: 'temp_access_grant', label: 'Temp Access Grant' },
  { value: 'temp_access_revoke', label: 'Temp Access Revoke' },
  { value: 'flag_create', label: 'Flag Create' },
  { value: 'flag_update', label: 'Flag Update' },
  { value: 'flag_delete', label: 'Flag Delete' },
  { value: 'platform_role_grant', label: 'Role Grant' },
  { value: 'platform_role_revoke', label: 'Role Revoke' },
  { value: 'member_invited', label: 'Member Invited' },
  { value: 'member_role_changed', label: 'Member Role Changed' },
  { value: 'member_removed', label: 'Member Removed' },
  { value: 'custom_role_created', label: 'Custom Role Created' },
  { value: 'custom_role_updated', label: 'Custom Role Updated' },
  { value: 'custom_role_deleted', label: 'Custom Role Deleted' },
  { value: 'api_key_created', label: 'API Key Created' },
  { value: 'api_key_deleted', label: 'API Key Deleted' },
  { value: 'permission_denied', label: 'Permission Denied' },
];

const TARGET_TYPES: AuditLogFilterOption<TargetType>[] = [
  { value: '', label: 'All Targets' },
  { value: 'tenant', label: 'Organization' },
  { value: 'profile', label: 'User' },
  { value: 'feature_flag', label: 'Feature Flag' },
  { value: 'temp_access_grant', label: 'Temp Access' },
  { value: 'membership', label: 'Membership' },
  { value: 'custom_role', label: 'Custom Role' },
  { value: 'app_member_role', label: 'App Role' },
  { value: 'api_key', label: 'API Key' },
  { value: 'permission', label: 'Permission' },
];

interface AuditLogListProps {
  onViewDetail?: (logId: string) => void;
}

export function AuditLogList({ onViewDetail }: AuditLogListProps) {
  return (
    <AuditLogTable
      fetchPage={listAuditLogs}
      actionTypes={ACTION_TYPES}
      targetTypes={TARGET_TYPES}
      onViewDetail={onViewDetail}
    />
  );
}
