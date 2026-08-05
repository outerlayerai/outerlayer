'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useTranslate } from '@outerlayer/locales';
import type { AppMemberRole } from '@/types/app-member-role';
import { RoleSelectDropdown } from '@/components/role-select-dropdown';
import {
  listAppRolesAction,
  assignAppRoleAction,
  updateAppRoleAction,
  updateAppCustomRoleAction,
  revokeAppRoleAction,
  listAppsForDropdownAction,
  setAppScopedAction,
  getAppScopedStatusAction,
} from '../actions';

/** Encode a role selection as either a built-in role string or "custom:<uuid>" */
function encodeRoleValue(role: AppMemberRole | null, customRoleId: string | null): string {
  if (customRoleId) return `custom:${customRoleId}`;
  return role ?? 'read';
}

/**
 * Flattens an `authorizedAction`'s two-layer result (wrapper ok/error, then
 * the service's own success/error) into the `{data?, error?}` shape this
 * component's branches already handle — including the raw `'entitlement_denied'`
 * string, so the existing per-call-site translation keeps working unchanged.
 */
function unwrapActionResult<T>(
  result:
    | { ok: true; data: { success: true; data: T } | { success: false; error: string } }
    | { ok: false; error: { message: string } },
): { data?: T; error?: string } {
  if (!result.ok) return { error: result.error.message };
  if (!result.data.success) return { error: result.data.error };
  return { data: result.data.data };
}

/**
 * Same flattening as `unwrapActionResult`, for the read actions — their
 * service functions return `{data}`/`{error}` directly (the `lib/system`
 * read-function shape) rather than the mutation services' `{success, ...}`.
 */
function unwrapReadActionResult<T>(
  result:
    | { ok: true; data: { data: T } | { error: string } }
    | { ok: false; error: { message: string } },
): { data?: T; error?: string } {
  if (!result.ok) return { error: result.error.message };
  if ('error' in result.data) return { error: result.data.error };
  return { data: result.data.data };
}

interface AppAccessRow {
  appId: string;
  name: string;
  enabled: boolean;
  /** Built-in role — null when customRoleId is set */
  role: AppMemberRole | null;
  /** Custom role ID — null when role is set */
  customRoleId: string | null;
  rowId: string | null;
  saving: boolean;
}

interface CustomRoleOption {
  id: string;
  name: string;
}

interface ManageAppAccessDialogProps {
  open: boolean;
  onClose: () => void;
  membershipId: string;
  userName: string;
  userEmail: string;
  /** Custom roles for the role dropdown — passed in rather than fetched, so
   *  this leaf never reaches into the custom-roles feature's actions. */
  customRoles: CustomRoleOption[];
}

export function ManageAppAccessDialog({
  open,
  onClose,
  membershipId,
  userName,
  userEmail,
  customRoles,
}: ManageAppAccessDialogProps) {
  const [rows, setRows] = useState<AppAccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAppScoped, setIsAppScoped] = useState(false);
  const [masterToggleSaving, setMasterToggleSaving] = useState(false);
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslate();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [appsResultRaw, rolesResultRaw, scopedResultRaw] = await Promise.all([
        listAppsForDropdownAction({}),
        listAppRolesAction({ membershipId }),
        getAppScopedStatusAction({ membershipId }),
      ]);
      const appsResult = unwrapReadActionResult(appsResultRaw);
      const rolesResult = unwrapReadActionResult(rolesResultRaw);
      const scopedResult = unwrapReadActionResult(scopedResultRaw);

      if (!appsResult || appsResult.error) {
        enqueueSnackbar(appsResult?.error ?? t('dashboard.settings.manageAppAccessDialog.failedLoadApps'), { variant: 'error' });
        return;
      }
      if (!rolesResult || rolesResult.error) {
        enqueueSnackbar(rolesResult?.error ?? t('dashboard.settings.manageAppAccessDialog.failedLoadRoles'), { variant: 'error' });
        return;
      }

      if (!scopedResult || scopedResult.error) {
        enqueueSnackbar(scopedResult?.error ?? t('dashboard.settings.manageAppAccessDialog.failedLoadData'), { variant: 'error' });
        return;
      }
      setIsAppScoped(scopedResult.data?.isAppScoped ?? false);

      // Build a lookup from appId → existing assignment
      const roleMap = new Map<string, { rowId: string; role: AppMemberRole | null; customRoleId: string | null }>();
      for (const r of rolesResult.data ?? []) {
        roleMap.set(r.appId, {
          rowId: r.id,
          role: r.role as AppMemberRole | null,
          customRoleId: (r as any).custom_role_id ?? null,
        });
      }

      // Merge all apps with their current access state
      const merged: AppAccessRow[] = (appsResult.data ?? []).map((app) => {
        const existing = roleMap.get(app.appId);
        return {
          appId: app.appId, // UUID from DB — used directly, never from user input
          name: app.name,
          enabled: !!existing,
          role: existing?.role ?? 'read',
          customRoleId: existing?.customRoleId ?? null,
          rowId: existing?.rowId ?? null,
          saving: false,
        };
      });

      setRows(merged);
    } catch (err) {
      console.error('[ManageAppAccessDialog] loadData failed:', err);
      enqueueSnackbar(t('dashboard.settings.manageAppAccessDialog.failedLoadData'), { variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [membershipId, enqueueSnackbar, t]);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  const setSaving = (appId: string, saving: boolean) => {
    setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, saving } : r)));
  };

  const handleMasterToggle = async (checked: boolean) => {
    setMasterToggleSaving(true);
    try {
      const result = unwrapActionResult(await setAppScopedAction({ membershipId, isAppScoped: checked }));
      if (!result || result.error) {
        const errMsg = result?.error === 'entitlement_denied'
          ? t('dashboard.settings.manageAppAccessDialog.enterpriseRequired')
          : (result?.error ?? t('dashboard.settings.manageAppAccessDialog.operationFailed'));
        enqueueSnackbar(errMsg, { variant: 'error' });
        return;
      }
      setIsAppScoped(checked);
    } catch (err) {
      console.error('[ManageAppAccessDialog] master toggle failed:', err);
      enqueueSnackbar(t('dashboard.settings.manageAppAccessDialog.operationFailed'), { variant: 'error' });
    } finally {
      setMasterToggleSaving(false);
    }
  };

  const handleToggle = async (appId: string, enabled: boolean) => {
    const row = rows.find((r) => r.appId === appId);
    if (!row) return;

    setSaving(appId, true);
    try {
      if (enabled) {
        // Grant access — appId is a UUID loaded directly from the database
        // Default to built-in 'read' role when granting new access
        const result = unwrapActionResult(
          await assignAppRoleAction({ membershipId, appId, role: row.role ?? 'read' }),
        );
        if (!result || result.error) {
          // Revert the toggle — server rejected the change
          setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, enabled: false } : r)));
          const errMsg = result?.error === 'entitlement_denied'
            ? t('dashboard.settings.manageAppAccessDialog.enterpriseRequired')
            : (result?.error ?? t('dashboard.settings.manageAppAccessDialog.failedGrantAccess'));
          enqueueSnackbar(errMsg, { variant: 'error' });
          return;
        }
        const newRowId = result.data?.id ?? null;
        setRows((prev) =>
          prev.map((r) => (r.appId === appId ? { ...r, enabled: true, rowId: newRowId, role: 'read', customRoleId: null } : r))
        );
        enqueueSnackbar(`${t('dashboard.settings.manageAppAccessDialog.accessGrantedTo')} ${row.name}`, { variant: 'success' });
      } else {
        if (!row.rowId) return;
        const result = unwrapActionResult(await revokeAppRoleAction({ appMemberRoleId: row.rowId }));
        if (!result || result.error) {
          // Revert the toggle — server rejected the change
          setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, enabled: true } : r)));
          const errMsg = result?.error === 'entitlement_denied'
            ? t('dashboard.settings.manageAppAccessDialog.enterpriseRequired')
            : (result?.error ?? t('dashboard.settings.manageAppAccessDialog.failedRevokeAccess'));
          enqueueSnackbar(errMsg, { variant: 'error' });
          return;
        }
        setRows((prev) =>
          prev.map((r) => (r.appId === appId ? { ...r, enabled: false, rowId: null } : r))
        );
        enqueueSnackbar(`${t('dashboard.settings.manageAppAccessDialog.accessRevokedFor')} ${row.name}`, { variant: 'success' });
      }
    } catch (err) {
      console.error('[ManageAppAccessDialog] toggle operation failed:', err);
      // Revert the toggle to its pre-click state
      setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, enabled: !enabled } : r)));
      enqueueSnackbar(t('dashboard.settings.manageAppAccessDialog.operationFailed'), { variant: 'error' });
    } finally {
      setSaving(appId, false);
    }
  };

  /**
   * Handles role change from RoleSelectDropdown.
   * Value is either a built-in role ('read'/'write'/'admin') or 'custom:<uuid>'.
   */
  const handleRoleChange = async (appId: string, newValue: string) => {
    const row = rows.find((r) => r.appId === appId);
    if (!row?.rowId) return;

    const isCustom = newValue.startsWith('custom:');
    const customRoleId = isCustom ? newValue.slice(7) : null;
    const builtInRole = isCustom ? null : (newValue as AppMemberRole);

    const previousRole = row.role;
    const previousCustomRoleId = row.customRoleId;

    // Optimistic update
    setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, role: builtInRole, customRoleId } : r)));
    setSaving(appId, true);
    try {
      let result;
      if (customRoleId) {
        result = unwrapActionResult(
          await updateAppCustomRoleAction({ appMemberRoleId: row.rowId, customRoleId }),
        );
      } else {
        result = unwrapActionResult(
          await updateAppRoleAction({ appMemberRoleId: row.rowId, role: builtInRole! }),
        );
      }
      if (!result || result.error) {
        enqueueSnackbar(result?.error ?? t('dashboard.settings.manageAppAccessDialog.failedUpdateRole'), { variant: 'error' });
        // Revert on failure
        setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, role: previousRole, customRoleId: previousCustomRoleId } : r)));
      }
    } catch (err) {
      console.error('[ManageAppAccessDialog] role update failed:', err);
      enqueueSnackbar(t('dashboard.settings.manageAppAccessDialog.failedUpdateRole'), { variant: 'error' });
      setRows((prev) => prev.map((r) => (r.appId === appId ? { ...r, role: previousRole, customRoleId: previousCustomRoleId } : r)));
    } finally {
      setSaving(appId, false);
    }
  };

  const handleClose = () => {
    setRows([]);
    setIsAppScoped(false);
    setLoading(true);
    onClose();
  };

  const enabledCount = rows.filter((r) => r.enabled).length;

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={handleClose}>
      <DialogTitle>
        {t('dashboard.settings.manageAppAccessDialog.title')} &mdash; {userName || userEmail}
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : rows.length === 0 ? (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              py: 4,
              textAlign: 'center'
            }}>
            {t('dashboard.settings.manageAppAccessDialog.noAppsFound')}
          </Typography>
        ) : (
          <>
            {/* Master toggle: is_app_scoped */}
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                mb: 1.5
              }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={isAppScoped}
                    onChange={(e) => handleMasterToggle(e.target.checked)}
                    disabled={masterToggleSaving}
                  />
                }
                label={
                  <Typography variant="body2" sx={{
                    fontWeight: 500
                  }}>
                    {t('dashboard.settings.manageAppAccessDialog.restrictToSpecificApps')}
                  </Typography>
                }
              />
              {masterToggleSaving && <CircularProgress size={16} />}
            </Stack>

            {!isAppScoped && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: 'block',
                  mb: 1
                }}>
                {t('dashboard.settings.manageAppAccessDialog.allAppsUnrestricted')}
              </Typography>
            )}

            {isAppScoped && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: 'block',
                  mb: 1
                }}>
                {enabledCount === 0
                  ? t('dashboard.settings.manageAppAccessDialog.noAppsAssigned')
                  : `${enabledCount} of ${rows.length} ${t('dashboard.settings.manageAppAccessDialog.appsEnabled')}`}
              </Typography>
            )}

            <Divider sx={{ mb: 0.5 }} />

            <Stack divider={<Divider />}>
              {rows.map((row) => (
                <Stack
                  key={row.appId}
                  direction="row"
                  spacing={1.5}
                  sx={{
                    alignItems: "center",
                    py: 1.25,
                    opacity: isAppScoped ? 1 : 0.5
                  }}>
                  <Typography variant="body2" sx={{ flex: 1, fontWeight: row.enabled ? 500 : 400 }}>
                    {row.name}
                  </Typography>

                  {row.enabled && isAppScoped && (
                    <RoleSelectDropdown
                      value={encodeRoleValue(row.role, row.customRoleId)}
                      onChange={(newValue) => handleRoleChange(row.appId, newValue)}
                      customRoles={customRoles}
                      customRolesEnabled={customRoles.length > 0}
                      disabled={row.saving}
                      size="small"
                      showOwner={false}
                      excludeDisabled
                    />
                  )}

                  <Switch
                    checked={row.enabled}
                    onChange={(e) => handleToggle(row.appId, e.target.checked)}
                    disabled={row.saving || !isAppScoped}
                    size="small"
                  />

                  {row.saving && <CircularProgress size={16} sx={{ flexShrink: 0 }} />}
                </Stack>
              ))}
            </Stack>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" onClick={handleClose}>
          {t('dashboard.settings.manageAppAccessDialog.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
