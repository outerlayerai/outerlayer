"use client";

import {
  Box,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogTitle,
  IconButton,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
} from "@mui/material";
import {
  TableHeadCustom,
  TablePaginationCustom,
  useTable,
} from "@/components/table";
import { useMemo, useState } from "react";
import { useTranslate } from "@outerlayer/locales";
import { UserRole, UserRoleEnum, useCurrentUser } from "@/lib/app-shell/use-current-user";
import Label from "@/components/label";
import { InviteUserModal } from "./invite-user-modal";
import { Stack } from "@mui/system";
import { SettingsSection } from "@/components/settings-shell";
import CustomPopover, { usePopover } from "@/components/custom-popover";
import Iconify from "@/components/iconify";
import { useBoolean } from "@/hooks/use-boolean";
import { changeMemberRoleAction, removeMemberAction, resendInviteAction } from "../actions";
import { useSnackbar } from "notistack";
import { revalidateServerPath } from "@/utils/actions";
import { usePathname } from "next/navigation";
import { RoleSelectDropdown } from "@/components/role-select-dropdown";

export type User = {
  role: UserRole;
  email?: string | undefined;
  id?: string | undefined;
  name?: string | null | undefined;
  isConfirmed?: boolean | undefined;
  membershipStatus?: "active" | "pending" | undefined;
  membershipId?: string | undefined;
  customRoleName?: string | undefined;
  customRoleId?: string | undefined;
};

interface CustomRoleOption {
  id: string;
  name: string;
}

interface AppOption {
  id: string;
  name: string;
}

type Props = {
  users: User[];
  appLevelRolesEnabled: boolean;
  customRolesEnabled: boolean;
  customRoles: CustomRoleOption[];
  /** Seeded server-side by the members page — passed through to the invite
   *  modal, which holds no browser data client of its own. */
  apps: AppOption[];
  /** Opens the app-access dialog for the given member. Composed above this
   *  leaf (the EE dialog lives outside src/features) — the menu item is
   *  hidden when this is absent. */
  onManageAppAccess?: (member: { membershipId: string; name: string | null; email: string | null }) => void;
};

const getTranslationKeys = () => {
  const parent = "dashboard.settings.inviteUsers";
  return {
    title: `${parent}.heading`,
    description: `${parent}.description`,
    name: `${parent}.userList.tableHeader.name`,
    email: `${parent}.userList.tableHeader.email`,
    role: `${parent}.userList.tableHeader.role`,
    inviteStatus: `${parent}.userList.tableHeader.inviteStatus`,
    inviteLinkSent: `${parent}.userList.inviteLinkSent`,
    inviteStatusPending: `${parent}.userList.inviteStatusPending`,
    inviteStatusAccepted: `${parent}.userList.inviteStatusAccepted`,
    updateRole: `${parent}.userList.updateRole`,
    removeUser: `${parent}.userList.removeUser`,
    resendInvite: `${parent}.userList.resendInvite`,
    owner: `${parent}.roleOwner`,
    admin: `${parent}.roleAdmin`,
    write: `${parent}.roleWrite`,
    read: `${parent}.roleRead`,
    cancel: `${parent}.userList.cancel`,
    confirmRemoveTitle: `${parent}.userList.confirm.removeTitle`,
    cannotRemoveLastOwner: `${parent}.userList.cannotRemoveLastOwner`,
    onlyOwnersCanPromote: `${parent}.userList.onlyOwnersCanPromote`,
    manageAppAccess: `${parent}.userList.manageAppAccess`,
  };
};

const translationKeys = getTranslationKeys();

export const UserList = ({
  users,
  appLevelRolesEnabled,
  customRolesEnabled,
  customRoles,
  apps,
  onManageAppAccess,
}: Props) => {
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingRole, setPendingRole] = useState<string>("");

  const currentUser = useCurrentUser();
  const table = useTable();
  const { t } = useTranslate();
  const popover = usePopover();
  const confirm = useBoolean();
  const menu = usePopover();

  const pathname = usePathname();

  const { enqueueSnackbar } = useSnackbar();

  const TABLE_HEAD = useMemo(() => {
    return [
      { id: "name", label: t(translationKeys.name) },
      { id: "email", label: t(translationKeys.email) },
      { id: "role", label: t(translationKeys.role) },
      { id: "invite-status", label: t(translationKeys.inviteStatus) },
      { id: "", width: 20 },
    ];
  }, [t]);

  const handleResendInviteLink = async () => {
    const result = await resendInviteAction({ email: selectedUser?.email! });

    if (!result.ok) {
      enqueueSnackbar(result.error.message, { variant: "error" });
      return;
    }
    if (!result.data.success) {
      enqueueSnackbar(result.data.error, { variant: "error" });
      return;
    }

    enqueueSnackbar(t(translationKeys.inviteLinkSent), {
      variant: "success",
    });

    popover.onClose();
  };

  const handleChangeUserRole = async (value: string) => {
    let role: UserRole;
    let customRoleId: string | null = null;

    if (value.startsWith("custom:")) {
      customRoleId = value.replace("custom:", "");
      role = "read" as UserRole; // built-in fallback; custom is active via customRoleId
    } else {
      role = value as UserRole;
    }

    if (!selectedUser?.id) return;
    const result = await changeMemberRoleAction({ userId: selectedUser.id, role, customRoleId });
    if (!result.ok) {
      enqueueSnackbar(result.error.message, { variant: "error" });
      return;
    }
    if (!result.data.success) {
      enqueueSnackbar(result.data.error, { variant: "error" });
      return;
    }
    await revalidateServerPath(pathname);
    menu.onClose();
    popover.onClose();
  };

  return (
    <SettingsSection
      description={t(translationKeys.description)}
    >
      <Stack spacing={2}>
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
          <InviteUserModal
            appLevelRolesEnabled={appLevelRolesEnabled}
            customRolesEnabled={customRolesEnabled}
            customRoles={customRoles}
            apps={apps}
          />
        </Stack>
        <Card>
          <TableContainer>
            <Box sx={{ flexGrow: 1, height: "100%", maxHeight: "100%", overflow: "auto" }}>
            <Box sx={{ minHeight: "100%" }}>
              <Table size={table.dense ? "small" : "medium"}>
                <TableHeadCustom headLabel={TABLE_HEAD} />
                <TableBody>
                  {users
                    .slice(
                      table.page * table.rowsPerPage,
                      table.page * table.rowsPerPage + table.rowsPerPage
                    )
                    .map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.name}</TableCell>
                        <TableCell>{row.email}</TableCell>
                        <TableCell>
                          <Label
                            variant="soft"
                            color={
                              (row.role === UserRoleEnum.OWNER && "warning") ||
                              (row.role === UserRoleEnum.ADMIN && "success") ||
                              (row.role === UserRoleEnum.WRITE && "info") ||
                              (row.role === UserRoleEnum.DISABLED && "error") ||
                              "default"
                            }
                          >
                            {row.customRoleName ?? row.role}
                          </Label>
                        </TableCell>
                        <TableCell>
                          <Label
                            variant="soft"
                            color={(row.membershipStatus === "active" && "primary") || "warning"}
                          >
                            {row.membershipStatus === "active"
                              ? t(translationKeys.inviteStatusAccepted)
                              : t(translationKeys.inviteStatusPending)}
                          </Label>
                        </TableCell>
                        <TableCell
                          align="right"
                          sx={{ px: 1, whiteSpace: "nowrap" }}
                        >
                          {row.email !== currentUser.email &&
                            row.role !== UserRoleEnum.DISABLED && (
                              <IconButton
                                color={popover.open ? "inherit" : "default"}
                                onClick={(e) => {
                                  setSelectedUser(row);
                                  popover.onOpen(e);
                                }}
                              >
                                <Iconify icon="eva:more-vertical-fill" />
                              </IconButton>
                            )}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </Box>
            </Box>
            <TablePaginationCustom
              count={users.length}
              page={table.page}
              rowsPerPage={table.rowsPerPage}
              onPageChange={table.onChangePage}
              onRowsPerPageChange={table.onChangeRowsPerPage}
              //
              dense={table.dense}
              onChangeDense={table.onChangeDense}
            />
          </TableContainer>
        </Card>
      </Stack>
      <CustomPopover
        open={popover.open}
        onClose={popover.onClose}
        arrow="right-top"
      >
        {selectedUser?.role !== UserRoleEnum.DISABLED && (
          <MenuItem onClick={(e) => {
            setPendingRole(
              selectedUser?.customRoleId
                ? `custom:${selectedUser.customRoleId}`
                : selectedUser?.role ?? ""
            );
            menu.onOpen(e);
          }}>
            <Iconify icon="dashicons:update" />
            {t(translationKeys.updateRole)}{" "}
            <Iconify sx={{ ml: 1 }} icon="mdi:chevron-right" />
          </MenuItem>
        )}
        {appLevelRolesEnabled &&
          selectedUser?.role !== UserRoleEnum.OWNER &&
          selectedUser?.membershipId &&
          onManageAppAccess && (
            <MenuItem
              onClick={() => {
                onManageAppAccess({
                  membershipId: selectedUser.membershipId!,
                  name: selectedUser.name ?? null,
                  email: selectedUser.email ?? null,
                });
                popover.onClose();
              }}
            >
              <Iconify icon="mdi:shield-key-outline" />
              {t(translationKeys.manageAppAccess)}
            </MenuItem>
          )}
        {selectedUser?.membershipStatus === "pending" && (
          <MenuItem onClick={handleResendInviteLink}>
            <Iconify icon="gg:redo" />
            {t(translationKeys.resendInvite)}
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            confirm.onTrue();
            popover.onClose();
          }}
          sx={{ color: "error.main" }}
        >
          <Iconify icon="mdi:account-remove" />
          {t(translationKeys.removeUser)}
        </MenuItem>
      </CustomPopover>
      <Dialog
        fullWidth
        maxWidth="xs"
        open={confirm.value}
        onClose={confirm.onFalse}
      >
        <DialogTitle sx={{ pb: 2 }}>
          {t(translationKeys.confirmRemoveTitle)}
        </DialogTitle>
        <DialogActions>
          <Button
            variant="contained"
            color="error"
            onClick={async () => {
              setLoading(true);
              if (!selectedUser?.id) return;
              const result = await removeMemberAction({ userId: selectedUser.id });
              if (!result.ok) {
                enqueueSnackbar(result.error.message, { variant: "error" });
                setLoading(false);
                return;
              }
              if (!result.data.success) {
                enqueueSnackbar(result.data.error, { variant: "error" });
                setLoading(false);
                return;
              }
              await revalidateServerPath(pathname);
              setLoading(false);
              confirm.onFalse();
            }}
            loading={loading}
          >
            {t(translationKeys.removeUser)}
          </Button>
          <Button variant="outlined" color="inherit" onClick={confirm.onFalse}>
            {t(translationKeys.cancel)}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        fullWidth
        maxWidth="xs"
        open={Boolean(menu.open)}
        onClose={menu.onClose}
      >
        <DialogTitle>Update Role</DialogTitle>
        <Stack sx={{ px: 3, pb: 3 }} spacing={2}>
          <RoleSelectDropdown
            value={pendingRole}
            onChange={(value) => setPendingRole(value)}
            customRoles={customRoles}
            customRolesEnabled={customRolesEnabled}
            showOwner={currentUser.role === UserRoleEnum.OWNER}
          />
          <Stack direction="row" spacing={1} sx={{
            justifyContent: "flex-end"
          }}>
            <Button variant="outlined" color="inherit" onClick={menu.onClose}>
              Cancel
            </Button>
            <Button
              variant="contained"
              loading={loading}
              disabled={
                pendingRole === (selectedUser?.customRoleId ? `custom:${selectedUser.customRoleId}` : selectedUser?.role)
              }
              onClick={async () => {
                setLoading(true);
                await handleChangeUserRole(pendingRole);
                setLoading(false);
              }}
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </Dialog>
    </SettingsSection>
  );
};
