"use client";

import { useState, useEffect, useCallback, type KeyboardEvent } from "react";
import {
  Alert,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { SettingsSection } from "@/components/settings-shell";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useBoolean } from "@/hooks/use-boolean";
import { useSnackbar } from '@/components/snackbar';
import {
  getSSOConfigAction,
  getSSOMembersAction,
  saveSSOConfigAction,
  testSSOConnectionAction,
  toggleSSOActiveAction,
  toggleSSOEnforcementAction,
  deleteSSOConfigAction,
} from "../actions";
import type { ActionResult } from "@/lib/action-kit/result";
import type { SSOConfig, SSODiagnostics, SSOIdentityWithProfile } from "@/types/sso";

/**
 * Unwraps the `authorizedAction` result envelope into the action's own
 * `{ ..., error? }` payload shape, so the rest of this component branches on
 * one `error` field regardless of whether the permission gate or the
 * handler itself produced it.
 */
function unwrapAction<T extends { error?: string }>(result: ActionResult<T>): T {
  if (!result.ok) {
    return { error: result.error.message } as T;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStatusLabel(config: SSOConfig | null): string {
  if (!config) return "Not configured";
  if (config.enforcement_enabled) return "Enforced";
  if (config.is_active) return "Active";
  return "Configured";
}

function getStatusColor(
  config: SSOConfig | null,
): "default" | "success" | "info" | "warning" {
  if (!config) return "default";
  if (config.enforcement_enabled) return "warning";
  if (config.is_active) return "success";
  return "info";
}

// ---------------------------------------------------------------------------
// Upgrade Prompt (non-enterprise)
// ---------------------------------------------------------------------------

function SSOUpgradePrompt() {
  return (
    <Stack
      sx={{
        alignItems: "center",
        gap: 2,
        py: 2
      }}>
      <Typography variant="h6">Single Sign-On (SSO)</Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          textAlign: "center"
        }}>
        SSO is available on the Team plan or above. Upgrade to enable.
      </Typography>
      <Button
        variant="outlined"
        href="mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise"
        target="_blank"
        rel="noopener noreferrer"
      >
        Contact Sales
      </Button>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics Display
// ---------------------------------------------------------------------------

function DiagnosticsAlert({ diagnostics }: { diagnostics: SSODiagnostics }) {
  const hasErrors = diagnostics.errors.length > 0;
  const allGood =
    diagnostics.metadataReachable &&
    diagnostics.metadataValid &&
    diagnostics.certificateValid;

  return (
    <Alert severity={allGood ? "success" : "warning"} sx={{ width: "100%" }}>
      <Stack sx={{
        gap: 0.5
      }}>
        <Typography variant="subtitle2">Connection Diagnostics</Typography>
        <Typography variant="body2">
          Metadata reachable: {diagnostics.metadataReachable ? "Yes" : "No"}
        </Typography>
        <Typography variant="body2">
          Metadata valid: {diagnostics.metadataValid ? "Yes" : "No"}
        </Typography>
        <Typography variant="body2">
          Certificate valid: {diagnostics.certificateValid ? "Yes" : "No"}
        </Typography>
        {diagnostics.certificateExpiresAt && (
          <Typography variant="body2">
            Certificate expires: {diagnostics.certificateExpiresAt}
          </Typography>
        )}
        {diagnostics.entityId && (
          <Typography variant="body2">
            Entity ID: {diagnostics.entityId}
          </Typography>
        )}
        <Typography variant="body2">
          ACS URL: {diagnostics.acsUrl}
        </Typography>
        {hasErrors && (
          <Stack
            sx={{
              gap: 0.5,
              mt: 1
            }}>
            {diagnostics.errors.map((err, idx) => (
              <Typography key={idx} variant="body2" color="error">
                {err}
              </Typography>
            ))}
          </Stack>
        )}
      </Stack>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function SSOSettings() {
  const { enqueueSnackbar } = useSnackbar();
  const confirmDelete = useBoolean();

  // Entitlement state
  const [isEnterprise, setIsEnterprise] = useState(false);

  // Loading / error state
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Config data
  const [config, setConfig] = useState<SSOConfig | null>(null);
  const [ssoMembers, setSsoMembers] = useState<SSOIdentityWithProfile[]>([]);

  // Form fields
  const [metadataUrl, setMetadataUrl] = useState("");
  const [metadataUrlError, setMetadataUrlError] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);

  // Action loading states
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isTogglingActive, setIsTogglingActive] = useState(false);
  const [isTogglingEnforcement, setIsTogglingEnforcement] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Test diagnostics
  const [diagnostics, setDiagnostics] = useState<SSODiagnostics | null>(null);

  // -----------------------------------------------------------------------
  // Load config on mount
  // -----------------------------------------------------------------------

  const loadMembers = useCallback(async () => {
    const result = unwrapAction(await getSSOMembersAction({}));
    if (result.error) {
      enqueueSnackbar(`Failed to load SSO members: ${result.error}`, { variant: "error" });
    }
    if (result.members) {
      setSsoMembers(result.members);
    }
  }, [enqueueSnackbar]);

  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = unwrapAction(await getSSOConfigAction({}));

      setIsEnterprise(result.isEnterprise ?? false);

      if (result.error) {
        setError(result.error);
      }

      if (result.config) {
        setConfig(result.config);
        setMetadataUrl(result.config.metadata_url ?? "");
        setAllowedDomains(result.config.allowed_domains ?? []);
        await loadMembers();
      }
    } finally {
      setIsLoading(false);
    }
  }, [loadMembers]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // -----------------------------------------------------------------------
  // Domain chip management
  // -----------------------------------------------------------------------

  const handleDomainKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();

      const domain = domainInput.trim().toLowerCase();

      if (!domain) return;

      if (allowedDomains.includes(domain)) {
        enqueueSnackbar("Domain already added", { variant: "warning" });
        return;
      }

      setAllowedDomains((prev) => [...prev, domain]);
      setDomainInput("");
    },
    [domainInput, allowedDomains, enqueueSnackbar],
  );

  const handleRemoveDomain = useCallback((domainToRemove: string) => {
    setAllowedDomains((prev) => prev.filter((d) => d !== domainToRemove));
  }, []);

  // -----------------------------------------------------------------------
  // Save config
  // -----------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    const trimmedUrl = metadataUrl.trim();

    if (!trimmedUrl) {
      setMetadataUrlError("Metadata URL is required");
      return;
    }

    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "https:") {
        setMetadataUrlError("Metadata URL must use HTTPS");
        return;
      }
      setMetadataUrlError(null);
    } catch {
      setMetadataUrlError("Metadata URL is not a valid URL");
      return;
    }

    setIsSaving(true);

    try {
      const result = unwrapAction(
        await saveSSOConfigAction({
          metadataUrl: metadataUrl.trim(),
          allowedDomains,
        }),
      );

      if (result.error) {
        enqueueSnackbar(result.error, { variant: "error" });
      } else if (result.config) {
        setConfig(result.config);
        enqueueSnackbar("SSO configuration saved", { variant: "success" });
      } else {
        console.error("[SSO] saveSSOConfig returned neither config nor error — unexpected state");
        enqueueSnackbar("An unexpected error occurred saving SSO configuration.", { variant: "error" });
      }
    } finally {
      setIsSaving(false);
    }
  }, [metadataUrl, allowedDomains, enqueueSnackbar]);

  // -----------------------------------------------------------------------
  // Test connection
  // -----------------------------------------------------------------------

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setDiagnostics(null);

    try {
      const result = unwrapAction(await testSSOConnectionAction({}));

      if (result.error) {
        enqueueSnackbar(result.error, { variant: "error" });
      } else if (result.diagnostics) {
        setDiagnostics(result.diagnostics);
      }
    } finally {
      setIsTesting(false);
    }
  }, [enqueueSnackbar]);

  // -----------------------------------------------------------------------
  // Toggle active
  // -----------------------------------------------------------------------

  const handleToggleActive = useCallback(
    async (_: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      setIsTogglingActive(true);

      try {
        const result = unwrapAction(await toggleSSOActiveAction({ active: checked }));

        if (result.error) {
          enqueueSnackbar(result.error, { variant: "error" });
        } else {
          setConfig((prev) =>
            prev ? { ...prev, is_active: checked, enforcement_enabled: checked ? prev.enforcement_enabled : false } : prev,
          );
          enqueueSnackbar(
            checked ? "SSO activated" : "SSO deactivated",
            { variant: "success" },
          );
        }
      } finally {
        setIsTogglingActive(false);
      }
    },
    [enqueueSnackbar],
  );

  // -----------------------------------------------------------------------
  // Toggle enforcement
  // -----------------------------------------------------------------------

  const handleToggleEnforcement = useCallback(
    async (_: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      setIsTogglingEnforcement(true);

      try {
        const result = unwrapAction(await toggleSSOEnforcementAction({ enforced: checked }));

        if (result.error) {
          enqueueSnackbar(result.error, { variant: "error" });
        } else {
          setConfig((prev) =>
            prev ? { ...prev, enforcement_enabled: checked } : prev,
          );
          enqueueSnackbar(
            checked ? "SSO enforcement enabled" : "SSO enforcement disabled",
            { variant: "success" },
          );
        }
      } finally {
        setIsTogglingEnforcement(false);
      }
    },
    [enqueueSnackbar],
  );

  // -----------------------------------------------------------------------
  // Delete config
  // -----------------------------------------------------------------------

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);

    try {
      const result = unwrapAction(await deleteSSOConfigAction({}));

      if (result.error) {
        enqueueSnackbar(result.error, { variant: "error" });
      } else {
        setConfig(null);
        setMetadataUrl("");
        setAllowedDomains([]);
        setDiagnostics(null);
        enqueueSnackbar("SSO configuration deleted", { variant: "success" });
      }
    } finally {
      setIsDeleting(false);
      confirmDelete.onFalse();
    }
  }, [enqueueSnackbar, confirmDelete]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (isLoading) {
    return (
      <SettingsSection title="Single Sign-On (SSO)" description="Configure SAML-based SSO for your organization.">
        <Skeleton variant="rectangular" width="100%" height={200} />
      </SettingsSection>
    );
  }

  if (error && !isEnterprise) {
    return (
      <SettingsSection title="Single Sign-On (SSO)" description="Configure SAML-based SSO for your organization.">
        <Alert severity="error">{error}</Alert>
      </SettingsSection>
    );
  }

  if (!isEnterprise) {
    return (
      <SettingsSection title="Single Sign-On (SSO)" description="Configure SAML-based SSO for your organization.">
        <SSOUpgradePrompt />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Single Sign-On (SSO)" description="Configure SAML-based SSO for your organization.">
      <Stack sx={{
        gap: 3
      }}>
        {/* Status header */}
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between"
          }}>
          <Typography variant="subtitle1">SSO Status</Typography>
          <Chip
            label={getStatusLabel(config)}
            color={getStatusColor(config)}
            size="small"
          />
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Metadata URL */}
        <TextField
          label="IdP SAML Metadata URL"
          placeholder="https://login.microsoftonline.com/.../federationmetadata/2007-06/federationmetadata.xml"
          value={metadataUrl}
          onChange={(e) => {
            setMetadataUrl(e.target.value);
            if (metadataUrlError) setMetadataUrlError(null);
          }}
          fullWidth
          required
          error={!!metadataUrlError}
          helperText={metadataUrlError ?? "The URL where your identity provider publishes SAML metadata."}
        />

        {/* Allowed Domains */}
        <Stack sx={{
          gap: 1
        }}>
          <TextField
            label="Allowed Email Domains"
            placeholder="example.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            onKeyDown={handleDomainKeyDown}
            fullWidth
            helperText="Type a domain and press Enter to add it."
          />
          {allowedDomains.length > 0 && (
            <Stack
              direction="row"
              sx={{
                gap: 1,
                flexWrap: "wrap"
              }}>
              {allowedDomains.map((domain) => (
                <Chip
                  key={domain}
                  label={domain}
                  onDelete={() => handleRemoveDomain(domain)}
                  size="small"
                />
              ))}
            </Stack>
          )}
        </Stack>

        {/* Save and Test buttons */}
        <Stack
          direction="row"
          sx={{
            gap: 2,
            justifyContent: "flex-end"
          }}>
          <Button
            variant="outlined"
            loading={isTesting}
            onClick={handleTest}
            disabled={!config}
          >
            Test Connection
          </Button>
          <Button
            variant="contained"
            loading={isSaving}
            onClick={handleSave}
          >
            Save Configuration
          </Button>
        </Stack>

        {/* Diagnostics result */}
        {diagnostics && <DiagnosticsAlert diagnostics={diagnostics} />}

        {/* Toggles section (only shown when config exists) */}
        {config && (
          <>
            <Divider />

            <Stack sx={{
              gap: 2
            }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={config.is_active}
                    onChange={handleToggleActive}
                    disabled={isTogglingActive}
                  />
                }
                label={
                  <Stack>
                    <Typography variant="body1">Activate SSO</Typography>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      Allow organization members to sign in with your identity provider.
                    </Typography>
                  </Stack>
                }
              />

              <FormControlLabel
                control={
                  <Switch
                    checked={config.enforcement_enabled}
                    onChange={handleToggleEnforcement}
                    disabled={!config.is_active || isTogglingEnforcement}
                  />
                }
                label={
                  <Stack>
                    <Typography variant="body1">Enforce SSO</Typography>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      Require all members with matching email domains to sign in via SSO.
                    </Typography>
                  </Stack>
                }
              />
            </Stack>

            {config?.is_active && (
              <>
                <Divider />
                <Stack sx={{
                  gap: 2
                }}>
                  <Typography variant="subtitle1">SSO Members</Typography>
                  {ssoMembers.length === 0 ? (
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      No members have signed in via SSO yet.
                    </Typography>
                  ) : (
                    <Stack sx={{
                      gap: 1
                    }}>
                      {ssoMembers.map((member) => (
                        <Stack
                          key={member.user_id}
                          direction="row"
                          sx={{
                            alignItems: "center",
                            justifyContent: "space-between",
                            py: 0.5
                          }}>
                          <Stack>
                            <Typography variant="body2">{member.email}</Typography>
                            <Typography variant="caption" sx={{
                              color: "text.secondary"
                            }}>
                              Last login: {member.last_login_at
                                ? new Date(member.last_login_at).toLocaleDateString()
                                : "Never"}
                            </Typography>
                          </Stack>
                          <Chip
                            label="SSO"
                            size="small"
                            color="success"
                            variant="outlined"
                          />
                        </Stack>
                      ))}
                    </Stack>
                  )}
                </Stack>
              </>
            )}

            <Divider />

            {/* Delete SSO */}
            <Stack direction="row" sx={{
              justifyContent: "flex-start"
            }}>
              <Button
                variant="outlined"
                color="error"
                loading={isDeleting}
                onClick={confirmDelete.onTrue}
              >
                Delete SSO Configuration
              </Button>
            </Stack>
          </>
        )}
      </Stack>
      {/* Delete confirmation dialog */}
      <ConfirmDeleteDialog
        open={confirmDelete.value}
        onClose={confirmDelete.onFalse}
        onConfirm={handleDelete}
        loading={isDeleting}
        title="Delete SSO configuration"
        confirmationText="delete"
      >
        <Typography variant="body2">
          Are you sure you want to delete the SSO configuration? This action
          cannot be undone.
        </Typography>
      </ConfirmDeleteDialog>
    </SettingsSection>
  );
}
