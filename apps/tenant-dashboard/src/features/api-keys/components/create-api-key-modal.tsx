"use client";

import {
  Typography,
  DialogTitle,
  DialogActions,
  Button,
  Dialog,
  DialogContent,
  Stack,
  IconButton,
  Tooltip,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Chip,
  Box,
  FormHelperText,
} from "@mui/material";
import FormProvider, { RHFTextField } from "@/components/hook-form";
import { useTranslate } from "@outerlayer/locales";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useBoolean } from "@/hooks/use-boolean";
import { useSnackbar } from '@/components/snackbar';
import { createApiKeyAction } from "../actions";
import { useState, useCallback, useEffect } from "react";
import Iconify from "@/components/iconify";
import { useAppContext } from "@/lib/app-shell/app-context";
import { useSelectedEnv } from "@/hooks/environments";
import { ENV_TARGET_KINDS } from "@repo/env-kind";
import { UpgradePrompt } from "@/components/upgrade-prompt";
import type { EntitlementDeniedInfo } from "@/config/entitlements";
import {
  GATEWAY_ROLES,
  GATEWAY_PERMISSIONS,
  PERMISSION_CATEGORIES,
  getPermissionsForRole,
} from "@/lib/gateway-permissions";

// Chip styling for the environment-scope selectors. The default MUI "primary"
// fill rendered as a washed-out light chip with near-invisible label text, so we
// pin the selected state to a solid, readable blue with a light-blue hover.
const scopeChipSx = (selected: boolean) => ({
  fontWeight: 500,
  ...(selected
    ? {
        bgcolor: "primary.main",
        color: "primary.contrastText",
        borderColor: "primary.main",
        "&:hover": { bgcolor: "primary.dark" },
      }
    : {
        color: "text.primary",
        "&:hover": { bgcolor: "primary.lighter", borderColor: "primary.light" },
      }),
});

export const CreateApiKeyModal = ({
  canCreateApiKey,
}: {
  canCreateApiKey: boolean;
}) => {
  const dialog = useBoolean();
  const [apiKey, setApiKey] = useState<string>("");
  const [deniedInfo, setDeniedInfo] = useState<EntitlementDeniedInfo | null>(null);
  const apiKeyDialog = useBoolean();

  const { t } = useTranslate();
  const { enqueueSnackbar } = useSnackbar();

  const { app } = useAppContext();
  // The breadcrumb-selected environment — a key created here binds to it.
  // `id` is null until the env list resolves (or when the selected name is
  // unknown); creating during that window would silently mint a key into the
  // DEFAULT env via the server-side fallback, so submission is blocked until
  // the id is concrete.
  const selectedEnv = useSelectedEnv();
  const envUnresolved = selectedEnv.id === null;

  const [selectedRole, setSelectedRole] = useState<string>("sdk");
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(
    () => getPermissionsForRole("sdk")
  );
  // Env scope: pin to the current env (default), or scope to a set of kinds so
  // ONE key reaches every env of those kinds — including future PR previews.
  const [kindScoped, setKindScoped] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<string[]>(["preview"]);

  // Start every fresh open from the default scope. Otherwise the env-scope
  // selection from a prior create persists (rhf reset() only clears the name),
  // so reopening after minting a kind-scoped key silently pre-selects kinds and
  // a user expecting the pinned-env default mints another kind-scoped key.
  useEffect(() => {
    if (dialog.value) {
      setKindScoped(false);
      setSelectedKinds(["preview"]);
    }
  }, [dialog.value]);

  const handleRoleChange = useCallback((roleId: string) => {
    setSelectedRole(roleId);
    if (roleId !== "custom") {
      setSelectedPermissions(getPermissionsForRole(roleId));
    }
  }, []);

  const handlePermissionToggle = useCallback((permissionKey: string) => {
    setSelectedPermissions((prev) =>
      prev.includes(permissionKey)
        ? prev.filter((p) => p !== permissionKey)
        : [...prev, permissionKey]
    );
  }, []);

  const Schema = z.object({
    name: z
      .string()
      .min(1, t("auth.validation.name.required"))
      .max(100, t("auth.validation.name.max")),
  });

  const defaultValues = {
    name: "",
  };

  const methods = useForm({
    resolver: zodResolver(Schema),
    defaultValues,
  });

  const {
    reset,
    handleSubmit,
    setError,
    formState: { isSubmitting },
  } = methods;

  const [permissionError, setPermissionError] = useState<string>("");

  const handleCreate = handleSubmit(async (data) => {
    if (!kindScoped && envUnresolved) return;
    if (selectedPermissions.length === 0) {
      setPermissionError("Select a role or at least one permission");
      return;
    }
    if (kindScoped && selectedKinds.length === 0) {
      setPermissionError("Select at least one environment kind");
      return;
    }
    setPermissionError("");

    try {
      const result = await createApiKeyAction({
        name: data.name,
        appId: app?.id as string,
        permissions: selectedPermissions,
        // A kind-scoped key carries no env pin; a pinned key binds to the
        // selected env (guarded above so the default-env fallback can't kick in).
        environmentId: kindScoped ? undefined : (selectedEnv.id ?? undefined),
        allowedEnvKinds: kindScoped ? selectedKinds : undefined,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const outcome = result.data;
      if (!outcome.ok) {
        if ('entitlement' in outcome) {
          setDeniedInfo(outcome.entitlement);
          return;
        }
        throw new Error(outcome.message);
      }
      setDeniedInfo(null);
      setApiKey(outcome.apiKey);
      apiKeyDialog.onTrue();
      reset();
      setSelectedRole("sdk");
      setSelectedPermissions(getPermissionsForRole("sdk"));
      setPermissionError("");
      dialog.onFalse();
    } catch (error: any) {
      setError("name", { message: (error as Error).message });
      enqueueSnackbar((error as Error).message, {
        variant: "error",
      });
    }
  });

  const ShowApiKeyDialog = (
    <Dialog
      open={apiKeyDialog.value}
      onClose={() => {
        reset();
        apiKeyDialog.onFalse();
      }}
      maxWidth={"sm"}
      fullWidth={true}
    >
      <DialogTitle>
        {t("dashboard.developers.apiKeyTitle")}
        <Typography>
          {t("dashboard.developers.apiKeyDescription1")}{" "}
          {t("dashboard.developers.apiKeyDescription2")}
        </Typography>
      </DialogTitle>

      <DialogContent>
        <Stack
          direction="row"
          sx={[{
            p: 2,
            alignItems: "center",
            justifyContent: "space-between",
            mb: 3
          }, ({ palette }) => ({
            backgroundColor: palette.background.neutral,
            borderRadius: 2,
          })]}>
          <Typography variant="body2" component="code">
            {apiKey}
          </Typography>
          <Tooltip placement="top" title={t("dashboard.developers.copy")}>
            <IconButton
              onClick={() => {
                navigator.clipboard.writeText(apiKey);
                enqueueSnackbar(t("dashboard.developers.copiedToClipboard"));
              }}
            >
              <Iconify icon="carbon:copy" />
            </IconButton>
          </Tooltip>
        </Stack>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      {canCreateApiKey && (
        <Stack sx={{
          alignItems: "flex-end"
        }}>
          <Button
            variant="contained"
            type="submit"
            onClick={dialog.onTrue}
          >
            {t("dashboard.developers.createButton")}
          </Button>
        </Stack>
      )}
      {ShowApiKeyDialog}
      <Dialog
        open={dialog.value}
        onClose={() => {
          reset();
          setSelectedRole("sdk");
          setSelectedPermissions(getPermissionsForRole("sdk"));
          setPermissionError("");
          dialog.onFalse();
        }}
        maxWidth={"sm"}
        fullWidth={true}
      >
        <FormProvider methods={methods} onSubmit={handleCreate}>
          <DialogTitle>
            {t("dashboard.developers.createApiKeyTitle")}
          </DialogTitle>

          <DialogContent>
            <Stack spacing={2} sx={{
              pt: 1
            }}>
              <RHFTextField
                name="name"
                label={t("dashboard.developers.name")}
              />

              <FormControl fullWidth>
                <InputLabel id="role-select-label">Role</InputLabel>
                <Select
                  labelId="role-select-label"
                  value={selectedRole}
                  label="Role"
                  onChange={(e) => handleRoleChange(e.target.value)}
                >
                  {GATEWAY_ROLES.map((role) => (
                    <MenuItem key={role.id} value={role.id}>
                      <Stack>
                        <Typography variant="body2">{role.label}</Typography>
                        <Typography variant="caption" sx={{
                          color: "text.secondary"
                        }}>
                          {role.description}
                        </Typography>
                      </Stack>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {selectedRole === "custom" ? (
                <Box>
                  {PERMISSION_CATEGORIES.map((category) => (
                    <Box key={category} sx={{
                      mb: 1
                    }}>
                      <Typography variant="subtitle2" gutterBottom>
                        {category}
                      </Typography>
                      <FormGroup>
                        {GATEWAY_PERMISSIONS.filter(
                          (p) => p.category === category
                        ).map((permission) => (
                          <FormControlLabel
                            key={permission.key}
                            control={
                              <Checkbox
                                size="small"
                                checked={selectedPermissions.includes(
                                  permission.key
                                )}
                                onChange={() =>
                                  handlePermissionToggle(permission.key)
                                }
                              />
                            }
                            label={
                              <Typography variant="body2">
                                {permission.label}
                              </Typography>
                            }
                          />
                        ))}
                      </FormGroup>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Box
                  sx={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 0.5
                  }}>
                  {selectedPermissions.map((perm) => (
                    <Chip key={perm} label={perm} size="small" />
                  ))}
                </Box>
              )}

              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Environment scope
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{
                  flexWrap: "wrap"
                }}>
                  <Chip
                    label={selectedEnv.name ? `Only ${selectedEnv.name}` : "This environment"}
                    onClick={() => setKindScoped(false)}
                    variant={!kindScoped ? "filled" : "outlined"}
                    size="small"
                    sx={scopeChipSx(!kindScoped)}
                  />
                  <Chip
                    label="Environment kinds"
                    onClick={() => setKindScoped(true)}
                    variant={kindScoped ? "filled" : "outlined"}
                    size="small"
                    sx={scopeChipSx(kindScoped)}
                  />
                </Stack>
                {kindScoped && (
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{
                      flexWrap: "wrap",
                      mt: 1
                    }}>
                    {ENV_TARGET_KINDS.map((k) => (
                      <Chip
                        key={k}
                        label={k === "promoted" ? "Production" : `${k.charAt(0).toUpperCase()}${k.slice(1)}`}
                        onClick={() =>
                          setSelectedKinds((prev) =>
                            prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
                          )
                        }
                        variant={selectedKinds.includes(k) ? "filled" : "outlined"}
                        size="small"
                        sx={scopeChipSx(selectedKinds.includes(k))}
                      />
                    ))}
                  </Stack>
                )}
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    mt: 0.5,
                    display: "block"
                  }}>
                  {kindScoped
                    ? "One key for every environment of the chosen kinds — including future PR previews."
                    : "Pins the key to the selected environment."}
                </Typography>
              </Box>

              {/* Always visible (not only for the custom role) — otherwise a
                  "select a permission / env kind" error is silently dropped on
                  the sdk/read-only roles. */}
              {permissionError && (
                <FormHelperText error>{permissionError}</FormHelperText>
              )}

              {deniedInfo && (
                <UpgradePrompt info={deniedInfo} variant="inline" />
              )}
            </Stack>
          </DialogContent>

          <DialogActions>
            <Stack spacing={0.5} sx={{
              alignItems: "flex-end"
            }}>
              {!kindScoped && envUnresolved && (
                <FormHelperText>
                  Resolving the selected environment…
                </FormHelperText>
              )}
              <Button
                loading={isSubmitting}
                disabled={
                  (!kindScoped && envUnresolved) ||
                  (kindScoped && selectedKinds.length === 0)
                }
                type="submit"
                variant="contained"
              >
                {t("dashboard.developers.saveButton")}
              </Button>
            </Stack>
          </DialogActions>
        </FormProvider>
      </Dialog>
    </>
  );
};
