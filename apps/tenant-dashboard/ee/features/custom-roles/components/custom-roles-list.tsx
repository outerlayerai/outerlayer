'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  Typography,
  Alert,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import { Stack } from '@mui/system';
import Iconify from '@/components/iconify';
import { LocalDate } from '@/components/local-date';
import {
  TableHeadCustom,
  TablePaginationCustom,
  useTable,
} from '@/components/table';
import { SettingsSection } from '@/components/settings-shell';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { CustomRoleForm } from './custom-role-form';
import { RoleSelectDropdown } from '@/components/role-select-dropdown';
import {
  listCustomRolesAction,
  createCustomRoleAction,
  updateCustomRoleAction,
  deleteCustomRoleAction,
  getCustomRoleAction,
} from '../actions';
import type { CustomRoleWithPermissions, CustomRoleDetail } from '@/types/custom-role';
import { dbPermissionsToKeys } from '@/utils/permissions';

type CustomRolesListProps = {
  customRolesEnabled: boolean;
  initialRoles?: CustomRoleWithPermissions[];
  activeEntitlements?: string[];
};

// ---------------------------------------------------------------------------
// Permission display helpers
// ---------------------------------------------------------------------------

function formatPermission(perm: string): string {
  return perm.replace(/\./g, ' ').replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Table Head
// ---------------------------------------------------------------------------

const TABLE_HEAD = [
  { id: 'name', label: 'Name' },
  { id: 'description', label: 'Description' },
  { id: 'permissions', label: 'Permissions', align: 'center' as const },
  { id: 'members', label: 'Members', align: 'center' as const },
  { id: 'created_at', label: 'Created', align: 'right' as const },
  { id: 'actions', label: '', width: 80 },
];

// ---------------------------------------------------------------------------
// Small sub-component for role detail dialog
// ---------------------------------------------------------------------------

function PermissionChips({ permissions }: { permissions: string[] }) {
  const uiKeys = useMemo(() => dbPermissionsToKeys(permissions), [permissions]);
  return (
    <>
      <Typography variant="subtitle2" gutterBottom>
        Permissions ({uiKeys.length})
      </Typography>
      <Stack
        direction="row"
        sx={{
          flexWrap: "wrap",
          gap: 0.5
        }}>
        {uiKeys.map((key) => (
          <Chip key={key} label={formatPermission(key)} size="small" variant="outlined" />
        ))}
      </Stack>
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomRolesList({ customRolesEnabled, initialRoles, activeEntitlements }: CustomRolesListProps) {
  const [roles, setRoles] = useState<CustomRoleWithPermissions[]>(initialRoles || []);
  const [createOpen, setCreateOpen] = useState(false);
  const [editRole, setEditRole] = useState<CustomRoleWithPermissions | null>(null);
  const [deleteRole, setDeleteRole] = useState<CustomRoleWithPermissions | null>(null);
  const [detailRole, setDetailRole] = useState<CustomRoleDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [fallbackRole, setFallbackRole] = useState('read');
  const [error, setError] = useState<string | null>(null);

  const table = useTable();

  const refreshRoles = useCallback(async () => {
    const result = await listCustomRolesAction({});
    if (!result.ok) {
      setError(`Failed to refresh roles: ${result.error.message}`);
      return;
    }
    if (!result.data.success) {
      setError(`Failed to refresh roles: ${result.data.error}`);
      return;
    }
    setRoles(result.data.data);
  }, []);

  // ── Create ──────────────────────────────────────────────────────────
  const handleCreate = async (
    name: string,
    description: string | undefined,
    permissions: string[],
  ) => {
    const result = await createCustomRoleAction({ name, description, permissions });
    if (!result.ok) return { error: result.error.message };
    if (!result.data.success) return { error: result.data.error };
    await refreshRoles();
    return {};
  };

  // ── Edit ────────────────────────────────────────────────────────────
  const handleEdit = async (
    name: string,
    description: string | undefined,
    permissions: string[],
  ) => {
    if (!editRole) return { error: 'No role selected' };
    const result = await updateCustomRoleAction({ roleId: editRole.id, name, description, permissions });
    if (!result.ok) return { error: result.error.message };
    if (!result.data.success) return { error: result.data.error };
    await refreshRoles();
    return {};
  };

  // ── Delete ──────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteRole) return;
    setDeleteLoading(true);
    setError(null);
    const result = await deleteCustomRoleAction({
      roleId: deleteRole.id,
      fallbackRole: deleteRole.memberCount > 0 ? fallbackRole : undefined,
    });
    if (!result.ok) {
      setError(result.error.message);
      setDeleteLoading(false);
      return;
    }
    if (!result.data.success) {
      setError(result.data.error);
      setDeleteLoading(false);
      return;
    }
    await refreshRoles();
    setDeleteRole(null);
    setFallbackRole('read');
    setDeleteLoading(false);
  };

  // ── View Details ────────────────────────────────────────────────────
  const handleViewDetails = async (roleId: string) => {
    const result = await getCustomRoleAction({ roleId });
    if (!result.ok) {
      setError(`Failed to load role details: ${result.error.message}`);
      return;
    }
    if (!result.data.success) {
      setError(`Failed to load role details: ${result.data.error}`);
      return;
    }
    setDetailRole(result.data.data);
    setDetailOpen(true);
  };

  // ── Feature-gated empty state ───────────────────────────────────────
  if (!customRolesEnabled) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        <Typography variant="h6" gutterBottom>
          Custom Roles
        </Typography>
        <Typography
          sx={{
            color: "text.secondary",
            mb: 2
          }}>
          Create custom roles with granular permissions for your team members.
        </Typography>
        <Alert severity="info" sx={{ maxWidth: 500, mx: 'auto' }}>
          Custom Roles is available on the Team plan. Upgrade to Team to unlock.
        </Alert>
      </Box>
    );
  }

  // ── Main UI ─────────────────────────────────────────────────────────
  return (
    <SettingsSection
      description="Create and manage custom permission roles for your organization."
    >
      <Stack spacing={2}>
        <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
          <Button
            variant="contained"
            startIcon={<Iconify icon="eva:plus-fill" />}
            onClick={() => setCreateOpen(true)}
          >
            Create Role
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {roles.length === 0 ? (
          <Typography
            sx={{
              color: "text.secondary",
              textAlign: 'center',
              py: 4
            }}>
            No custom roles yet. Create one to get started.
          </Typography>
        ) : (
          <Card>
            <TableContainer>
              <Box sx={{ flexGrow: 1, height: '100%', maxHeight: '100%', overflow: 'auto' }}>
              <Box sx={{ minHeight: '100%' }}>
                <Table size={table.dense ? 'small' : 'medium'}>
                  <TableHeadCustom headLabel={TABLE_HEAD} />
                  <TableBody>
                    {roles
                      .slice(
                        table.page * table.rowsPerPage,
                        table.page * table.rowsPerPage + table.rowsPerPage,
                      )
                      .map((role) => (
                        <TableRow key={role.id} hover>
                          <TableCell>
                            <Typography
                              variant="subtitle2"
                              sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                              onClick={() => handleViewDetails(role.id)}
                            >
                              {role.name}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography
                              variant="body2"
                              noWrap
                              sx={{
                                color: "text.secondary",
                                maxWidth: 200
                              }}>
                              {role.description || '\u2014'}
                            </Typography>
                          </TableCell>
                          <TableCell align="center">
                            <Chip label={dbPermissionsToKeys(role.permissions).length} size="small" />
                          </TableCell>
                          <TableCell align="center">
                            <Chip label={role.memberCount} size="small" variant="outlined" />
                          </TableCell>
                          <TableCell align="right">
                            <Typography variant="body2" sx={{
                              color: "text.secondary"
                            }}>
                              <LocalDate value={role.created_at} format="numericDate" />
                            </Typography>
                          </TableCell>
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            <IconButton
                              size="small"
                              onClick={() => setEditRole(role)}
                              title="Edit role"
                            >
                              <Iconify icon="solar:pen-bold" width={18} />
                            </IconButton>
                            <IconButton
                              size="small"
                              onClick={() => {
                                setDeleteRole(role);
                                setFallbackRole('read');
                              }}
                              title="Delete role"
                              color="error"
                            >
                              <Iconify icon="solar:trash-bin-trash-bold" width={18} />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </Box>
              </Box>
              <TablePaginationCustom
                count={roles.length}
                page={table.page}
                rowsPerPage={table.rowsPerPage}
                onPageChange={table.onChangePage}
                onRowsPerPageChange={table.onChangeRowsPerPage}
                dense={table.dense}
                onChangeDense={table.onChangeDense}
              />
            </TableContainer>
          </Card>
        )}
      </Stack>
      {/* Create dialog */}
      <CustomRoleForm
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
        activeEntitlements={activeEntitlements}
      />
      {/* Edit dialog */}
      {editRole && (
        <CustomRoleForm
          open={!!editRole}
          onClose={() => setEditRole(null)}
          onSubmit={handleEdit}
          initialData={{
            name: editRole.name,
            description: editRole.description,
            permissions: editRole.permissions,
          }}
          title={`Edit: ${editRole.name}`}
          activeEntitlements={activeEntitlements}
        />
      )}
      {/* Delete confirmation dialog */}
      <ConfirmDeleteDialog
        open={!!deleteRole}
        onClose={() => setDeleteRole(null)}
        onConfirm={handleDelete}
        loading={deleteLoading}
        title="Delete Custom Role"
        confirmationText={deleteRole?.name ?? ''}
      >
        <Typography>
          Are you sure you want to delete <strong>{deleteRole?.name}</strong>?
          This cannot be undone.
        </Typography>
        {deleteRole && deleteRole.memberCount > 0 && (
          <>
            <Alert severity="warning">
              This role is assigned to {deleteRole.memberCount} member(s).
              Choose a fallback role for them:
            </Alert>
            <RoleSelectDropdown
              value={fallbackRole}
              onChange={setFallbackRole}
              customRoles={roles
                .filter((r) => r.id !== deleteRole.id)
                .map((r) => ({ id: r.id, name: r.name }))}
              size="small"
            />
          </>
        )}
      </ConfirmDeleteDialog>
      {/* Role detail dialog */}
      <Dialog
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{detailRole?.name}</DialogTitle>
        <DialogContent>
          {detailRole && (
            <Stack spacing={2}>
              {detailRole.description && (
                <Typography sx={{
                  color: "text.secondary"
                }}>{detailRole.description}</Typography>
              )}

              <Box>
                <PermissionChips permissions={detailRole.permissions} />
              </Box>

              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Members ({detailRole.members.length})
                </Typography>
                {detailRole.members.length === 0 ? (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    No members assigned to this role yet. Assign members from the Members tab.
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {detailRole.members.map((member) => (
                      <ListItem key={member.membershipId} disablePadding sx={{ py: 0.5 }}>
                        <ListItemText
                          primary={member.userName}
                          secondary={member.userEmail}
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </SettingsSection>
  );
}
