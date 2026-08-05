"use client";

import { useEffect, useState } from "react";
import {
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Button,
  Stack,
  Typography,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { useTranslate } from "@outerlayer/locales";
import { useAppPermissions } from "@/lib/adapters/use-app-permissions";
import { useAppContext } from "@/lib/adapters/use-app-context";
import { SettingsSection } from "@/components/settings-shell";
import type { EnvVarRecord, EnvVarScope } from "../../types";
import {
  deleteEnvVar,
  revealEnvVarValue,
  setEnvVar,
  setEnvVarForTargets,
} from "../../actions";
import { EnvVarFormDialog } from "./EnvVarFormDialog";
import {
  type EnvVarTargetChoice,
  envVarRowTargetLabel,
  scopesFromChoices,
} from "./env-var-targets";

interface EnvVarEditorProps {
  appId: string;
  /** The breadcrumb-selected env — the target of the "Only <env>" override and
   *  the default the manager opens in. */
  currentEnvId: string;
  currentEnvName: string;
  /** Every env-var row for the app (specific-env AND kind-targeted). */
  envVars: EnvVarRecord[];
  /** environment_id → name, for labelling specific-env rows. */
  envNames: Record<string, string>;
}

/** The scope a stored row represents, for edit/value reads. */
function rowScope(row: EnvVarRecord): EnvVarScope {
  return row.environment_id != null
    ? { environmentId: row.environment_id }
    : { targetKind: row.target_kind! };
}

// ============================================================================
// Component
// ============================================================================

export function EnvVarEditor({
  appId,
  currentEnvId,
  currentEnvName,
  envVars: initialEnvVars,
  envNames,
}: EnvVarEditorProps) {
  const { t } = useTranslate();
  const { app } = useAppContext();
  const { hasPermission } = useAppPermissions(app?.id);

  const canInsertEnvVar = hasPermission("env_var.insert");
  const canUpdateEnvVar = hasPermission("env_var.update");
  const canDeleteEnvVar = hasPermission("env_var.delete");

  const [envVars, setEnvVars] = useState(initialEnvVars);

  useEffect(() => {
    setEnvVars(initialEnvVars);
  }, [initialEnvVars]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingVar, setEditingVar] = useState<EnvVarRecord | null>(null);
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>(
    {},
  );
  const [deleteConfirm, setDeleteConfirm] = useState<EnvVarRecord | null>(null);

  // No manual refetch: `setEnvVar`/`deleteEnvVar` revalidate the settings
  // route inside the action, so the React Server Component (RSC) re-seeds `envVars` and the effect
  // above picks up the fresh list.
  const handleSave = async (
    key: string,
    value: string,
    targets: EnvVarTargetChoice[],
  ) => {
    const result = editingVar
      ? await setEnvVar({ appId, scope: rowScope(editingVar), key, value })
      : await setEnvVarForTargets({
          appId,
          scopes: scopesFromChoices(targets, currentEnvId),
          key,
          value,
        });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    setRevealedValues((prev) => {
      const next = { ...prev };
      if (editingVar) delete next[editingVar.id];
      return next;
    });
  };

  const handleDelete = async (envVar: EnvVarRecord) => {
    const result = await deleteEnvVar({ appId, envVarId: envVar.id });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    setDeleteConfirm(null);
    setRevealedValues((prev) => {
      const next = { ...prev };
      delete next[envVar.id];
      return next;
    });
  };

  const handleReveal = async (envVar: EnvVarRecord) => {
    if (revealedValues[envVar.id]) {
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[envVar.id];
        return next;
      });
      return;
    }

    const result = await revealEnvVarValue({ appId, envVarId: envVar.id });
    if (result.ok && result.data.value !== null && result.data.value !== undefined) {
      setRevealedValues((prev) => ({
        ...prev,
        [envVar.id]: result.data.value!,
      }));
    }
  };

  const handleAdd = () => {
    setEditingVar(null);
    setDialogOpen(true);
  };

  const handleEdit = (envVar: EnvVarRecord) => {
    setEditingVar(envVar);
    setDialogOpen(true);
  };

  return (
    <>
      <SettingsSection
        title={t("dashboard.apps.envVars.title")}
        description="Scope a variable to a specific environment or to every environment of a kind (Development, Preview, Production)."
      >
        <Stack spacing={2}>
          {canInsertEnvVar && (
            <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
              <Button
                variant="contained"
                startIcon={<Iconify icon="eva:plus-fill" />}
                onClick={handleAdd}
              >
                {t("dashboard.apps.envVars.addButton")}
              </Button>
            </Stack>
          )}
          {envVars.length === 0 ? (
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t("dashboard.apps.envVars.noVariablesMessage")}
            </Typography>
          ) : (
            <List disablePadding>
              {envVars.map((envVar) => (
                <ListItem
                  key={envVar.id}
                  disablePadding
                  sx={{ py: 0.5 }}
                  secondaryAction={
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip
                        title={
                          revealedValues[envVar.id]
                            ? t("dashboard.apps.envVars.hideValueTooltip")
                            : t("dashboard.apps.envVars.revealValueTooltip")
                        }
                      >
                        <IconButton size="small" onClick={() => handleReveal(envVar)}>
                          <Iconify
                            icon={
                              revealedValues[envVar.id]
                                ? "eva:eye-off-fill"
                                : "eva:eye-fill"
                            }
                            width={18}
                          />
                        </IconButton>
                      </Tooltip>
                      {canUpdateEnvVar && (
                        <Tooltip title={t("dashboard.apps.envVars.editTooltip")}>
                          <IconButton size="small" onClick={() => handleEdit(envVar)}>
                            <Iconify icon="eva:edit-fill" width={18} />
                          </IconButton>
                        </Tooltip>
                      )}
                      {canDeleteEnvVar && (
                        <Tooltip title={t("dashboard.apps.envVars.deleteTooltip")}>
                          <IconButton
                            size="small"
                            onClick={() => setDeleteConfirm(envVar)}
                            color="error"
                          >
                            <Iconify icon="eva:trash-2-outline" width={18} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                  }
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} sx={{
                        alignItems: "center"
                      }}>
                        <Typography variant="body2" sx={{
                          fontFamily: "monospace"
                        }}>
                          {envVar.key}
                        </Typography>
                        <Chip
                          label={envVarRowTargetLabel(envVar, envNames)}
                          size="small"
                          variant="outlined"
                          color={envVar.environment_id ? "secondary" : "primary"}
                        />
                      </Stack>
                    }
                    secondary={
                      revealedValues[envVar.id]
                        ? revealedValues[envVar.id]
                        : "••••••••"
                    }
                  />
                </ListItem>
              ))}
            </List>
          )}
        </Stack>
      </SettingsSection>
      <EnvVarFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        initialKey={editingVar?.key}
        isEditing={!!editingVar}
        showTargets={!editingVar}
        currentEnvName={currentEnvName}
      />
      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)}>
        <DialogTitle>{t("dashboard.apps.envVars.deleteDialogTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("dashboard.apps.envVars.deleteConfirmMessage", { key: deleteConfirm?.key })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(null)}>{t("dashboard.apps.envVars.cancelButton")}</Button>
          <Button
            color="error"
            disabled={!canDeleteEnvVar}
            onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
          >
            {t("dashboard.apps.envVars.deleteButton")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
