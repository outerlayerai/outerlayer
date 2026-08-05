"use client";

import {
  MenuItem,
  Typography,
  DialogTitle,
  DialogActions,
  Button,
  Dialog,
  DialogContent,
  Stack,
  Switch,
  FormControlLabel,
  Select,
  IconButton,
  Divider,
  ListSubheader,
} from "@mui/material";
import FormProvider, { RHFSelect, RHFTextField } from "@/components/hook-form";
import { useTranslate } from "@outerlayer/locales";
import { useCallback, useState } from "react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useBoolean } from "@/hooks/use-boolean";
import { UserRole, UserRoleEnum } from "@/lib/app-shell/use-current-user";
import { sendInviteAction } from "../actions";
import { useSnackbar } from "@/components/snackbar";
import { UpgradePrompt } from "@/components/upgrade-prompt";
import { buildDeniedInfo } from "@/lib/app-shell/entitlement-denied";
import Iconify from "@/components/iconify";
import type { AppMemberRole } from "@/types/app-member-role";

interface AppOption {
  id: string;
  name: string;
}

interface AppRoleAssignment {
  appId: string;
  role: AppMemberRole;
}

interface CustomRoleOption {
  id: string;
  name: string;
}

interface InviteUserModalProps {
  appLevelRolesEnabled: boolean;
  customRolesEnabled: boolean;
  customRoles: CustomRoleOption[];
  /** Seeded server-side by the members page (RLS `app.read`) — the modal
   *  holds no browser data client, so it never fetches this itself. */
  apps: AppOption[];
}

const DEFAULT_APP_ROLE: AppMemberRole = "read";

export const InviteUserModal = ({ appLevelRolesEnabled, customRolesEnabled, customRoles, apps }: InviteUserModalProps) => {
  const dialog = useBoolean();

  // Per-app role state
  const [enableAppRoles, setEnableAppRoles] = useState(false);
  const [appRoleAssignments, setAppRoleAssignments] = useState<AppRoleAssignment[]>([]);

  const { t } = useTranslate();

  const { enqueueSnackbar } = useSnackbar();

  // Denied info for upgrade prompt (shown in invite modal when app roles section is visible but org is not enterprise)
  const appRolesDeniedInfo = !appLevelRolesEnabled ? buildDeniedInfo('app_level_roles') : null;

  // Per-app role helpers
  const addAssignment = useCallback(() => {
    setAppRoleAssignments((prev) => [...prev, { appId: "", role: DEFAULT_APP_ROLE }]);
  }, []);

  const removeAssignment = useCallback((index: number) => {
    setAppRoleAssignments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateAssignmentApp = useCallback((index: number, appId: string) => {
    setAppRoleAssignments((prev) =>
      prev.map((a, i) => (i === index ? { ...a, appId } : a))
    );
  }, []);

  const updateAssignmentRole = useCallback((index: number, role: AppMemberRole) => {
    setAppRoleAssignments((prev) =>
      prev.map((a, i) => (i === index ? { ...a, role } : a))
    );
  }, []);

  const resetAppRoles = useCallback(() => {
    setEnableAppRoles(false);
    setAppRoleAssignments([]);
  }, []);

  const validRoleValues = [
    ...Object.values(UserRoleEnum),
    ...customRoles.map((r) => `custom:${r.id}`),
  ];

  const InviteSchema = z.object({
    email: z
      .string()
      .min(1, t("auth.validation.email.required"))
      .email(t("auth.validation.email.invalid")),
    role: z.string().refine((val) => validRoleValues.includes(val)),
    name: z
      .string()
      .min(1, t("auth.validation.name.required"))
      .max(100, t("auth.validation.name.max")),
  });

  const defaultValues = {
    email: "",
    role: UserRoleEnum.READ,
    name: "",
  };

  const methods = useForm({
    resolver: zodResolver(InviteSchema),
    defaultValues,
  });

  const {
    reset,
    handleSubmit,
    setError,
    formState: { isSubmitting },
  } = methods;

  const handleSubmitInvite = handleSubmit(async (data) => {
    try {
      // Build valid app role assignments (only those with a selected app)
      const validAssignments = enableAppRoles && appLevelRolesEnabled
        ? appRoleAssignments.filter((a) => a.appId)
        : undefined;
      const appRolesPayload =
        validAssignments && validAssignments.length > 0 ? validAssignments : undefined;

      // Parse custom role selection: "custom:<uuid>" → built-in fallback role
      // "read" + customRoleId. The custom role is active via custom_role_id; the
      // role column keeps the real built-in fallback.
      let baseRole: UserRole = data.role as UserRole;
      let customRoleId: string | undefined;
      if (data.role.startsWith("custom:")) {
        customRoleId = data.role.slice("custom:".length);
        baseRole = UserRoleEnum.READ;
      }

      const result = await sendInviteAction({
        name: data.name,
        email: data.email,
        role: baseRole,
        appRoles: appRolesPayload,
        customRoleId,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      if (!result.data.success) {
        throw new Error(result.data.error);
      }
      enqueueSnackbar(t("dashboard.settings.inviteUsers.inviteSuccess"), {
        variant: "success",
      });
      reset();
      resetAppRoles();
    } catch (error: any) {
      setError("email", { message: error.message });
    }
  });

  return (
    <>
      <Stack sx={{
        alignItems: "flex-end"
      }}>
        <Button
          variant="contained"
          type="submit"
          size="small"
          onClick={dialog.onTrue}
        >
          {t("dashboard.settings.inviteUsers.inviteButton")}
        </Button>
      </Stack>
      <Dialog
        open={dialog.value}
        onClose={() => {
          reset();
          resetAppRoles();
          dialog.onFalse();
        }}
        maxWidth={"sm"}
        fullWidth={true}
      >
        <FormProvider methods={methods} onSubmit={handleSubmitInvite}>
          <DialogTitle>
            <Typography variant="h5" component="span" sx={{
              alignSelf: "flex-start"
            }}>
              {t("dashboard.settings.inviteUsers.heading")}
            </Typography>
            <Typography component="p" sx={{
              alignSelf: "flex-start"
            }}>
              {t("dashboard.settings.inviteUsers.description")}
            </Typography>
          </DialogTitle>

          <DialogContent>
            <Stack spacing={2} sx={{
              my: 2
            }}>
              <RHFTextField
                name="name"
                label={t("dashboard.settings.inviteUsers.namePlaceholder")}
              />
              <RHFTextField
                name="email"
                label={t("auth.register.emailPlaceholder")}
              />
              <RHFSelect
                name="role"
                label={t("dashboard.settings.inviteUsers.rolePlaceholder")}
              >
                <ListSubheader>Built-in Roles</ListSubheader>
                <MenuItem key={UserRoleEnum.ADMIN} value={UserRoleEnum.ADMIN}>
                  {t("dashboard.settings.inviteUsers.roleAdmin")}
                </MenuItem>
                <MenuItem key={UserRoleEnum.WRITE} value={UserRoleEnum.WRITE}>
                  {t("dashboard.settings.inviteUsers.roleWrite")}
                </MenuItem>
                <MenuItem key={UserRoleEnum.READ} value={UserRoleEnum.READ}>
                  {t("dashboard.settings.inviteUsers.roleRead")}
                </MenuItem>
                {customRolesEnabled && customRoles.length > 0 && <Divider />}
                {customRolesEnabled && customRoles.length > 0 && (
                  <ListSubheader>Custom Roles</ListSubheader>
                )}
                {customRolesEnabled &&
                  customRoles.map((role) => (
                    <MenuItem key={role.id} value={`custom:${role.id}`}>
                      {role.name}
                    </MenuItem>
                  ))}
              </RHFSelect>

              {/* Per-App Access Section — gated behind enterprise entitlement */}
              {appLevelRolesEnabled && apps.length > 0 && (
                <>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={enableAppRoles}
                        onChange={(e) => setEnableAppRoles(e.target.checked)}
                      />
                    }
                    label={t("dashboard.settings.inviteUsersAppRoles.restrictToApps")}
                  />

                  {enableAppRoles && (
                    <Stack spacing={1}>
                      {appRoleAssignments.map((assignment, index) => (
                        <Stack
                          direction="row"
                          spacing={1}
                          key={index}
                          sx={{
                            alignItems: "center"
                          }}
                        >
                          <Select
                            value={assignment.appId}
                            onChange={(e) =>
                              updateAssignmentApp(index, e.target.value)
                            }
                            displayEmpty
                            size="small"
                            sx={{ flex: 1 }}
                          >
                            <MenuItem value="" disabled>
                              {t("dashboard.settings.inviteUsersAppRoles.selectApp")}
                            </MenuItem>
                            {apps
                              .filter(
                                (app) =>
                                  app.id === assignment.appId ||
                                  !appRoleAssignments.some(
                                    (a) => a.appId === app.id
                                  )
                              )
                              .map((app) => (
                                <MenuItem key={app.id} value={app.id}>
                                  {app.name}
                                </MenuItem>
                              ))}
                          </Select>
                          <Select
                            value={assignment.role}
                            onChange={(e) =>
                              updateAssignmentRole(
                                index,
                                e.target.value as AppMemberRole
                              )
                            }
                            size="small"
                            sx={{ width: 160 }}
                          >
                            <ListSubheader>Built-in Roles</ListSubheader>
                            <MenuItem value="read">{t("dashboard.settings.inviteUsers.roleRead")}</MenuItem>
                            <MenuItem value="write">{t("dashboard.settings.inviteUsers.roleWrite")}</MenuItem>
                            <MenuItem value="admin">{t("dashboard.settings.inviteUsers.roleAdmin")}</MenuItem>
                            {customRolesEnabled && customRoles.length > 0 && <Divider />}
                            {customRolesEnabled && customRoles.length > 0 && (
                              <ListSubheader>Custom Roles</ListSubheader>
                            )}
                            {customRolesEnabled &&
                              customRoles.map((role) => (
                                <MenuItem key={role.id} value={`custom:${role.id}`}>
                                  {role.name}
                                </MenuItem>
                              ))}
                          </Select>
                          <IconButton
                            onClick={() => removeAssignment(index)}
                            size="small"
                          >
                            <Iconify
                              icon="solar:trash-bin-trash-bold"
                              width={18}
                            />
                          </IconButton>
                        </Stack>
                      ))}
                      <Button
                        size="small"
                        startIcon={<Iconify icon="mingcute:add-line" />}
                        onClick={addAssignment}
                        disabled={
                          appRoleAssignments.length >= apps.length
                        }
                      >
                        {t("dashboard.settings.inviteUsersAppRoles.addApp")}
                      </Button>
                    </Stack>
                  )}
                </>
              )}

              {/* Show upgrade prompt for non-enterprise orgs */}
              {!appLevelRolesEnabled && appRolesDeniedInfo && (
                <UpgradePrompt info={appRolesDeniedInfo} variant="inline" />
              )}
            </Stack>
          </DialogContent>

          <DialogActions>
            <Stack sx={{
              alignItems: "flex-end"
            }}>
              <Button
                loading={isSubmitting}
                type="submit"
                variant="contained"
                size="small"
              >
                {t("dashboard.settings.inviteUsers.inviteButton")}
              </Button>
            </Stack>
          </DialogActions>
        </FormProvider>
      </Dialog>
    </>
  );
};
