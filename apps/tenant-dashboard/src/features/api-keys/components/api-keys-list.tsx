"use client";

import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  Typography,
} from "@mui/material";
import type { EnvTargetKind } from "@repo/env-kind";

/**
 * Display labels for a key's env-kind scope. A feature never imports another
 * feature's internals (env-vars owns its own copy of this same mapping) —
 * duplicated here rather than shared, matching how `create-api-key-modal`
 * already labels kinds inline.
 */
const KIND_TARGET_LABELS: Record<EnvTargetKind, string> = {
  development: "Development",
  preview: "Preview",
  promoted: "Production",
};
import { Box, Stack } from "@mui/system";
import { CreateApiKeyModal } from "./create-api-key-modal";
import { EditApiKeyModal } from "./edit-api-key-modal";
import type { Tables } from "@/types/db";
import Iconify from "@/components/iconify";
import { LocalDate } from "@/components/local-date";
import { useTranslate } from "@outerlayer/locales";
import { useBoolean } from "@/hooks/use-boolean";
import { useState } from "react";
import { deleteApiKeyAction } from "../actions";
import { useSnackbar } from "notistack";
import EmptyContent from '@/components/empty-content';
import { useAppPermissions } from "@/lib/adapters/use-app-permissions";
import { useAppContext } from "@/lib/app-shell/app-context";
import { SettingsSection } from "@/components/settings-shell";

type ApiKey = Tables<"api_key">;

type Props = {
  apiKeys: ApiKey[];
  /** Name of the environment the listed keys belong to. */
  environmentName?: string;
};

export const ApiKeysList = ({ apiKeys, environmentName }: Props) => {
  const { t } = useTranslate();
  const { app } = useAppContext();
  const { hasPermission } = useAppPermissions(app?.id);
  const dialog = useBoolean();
  const [apiKeyIdForDelete, setApiKeyIdForDelete] = useState<string | null>(
    null
  );
  const [editKeyId, setEditKeyId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);

  const canDeleteApiKey = hasPermission("api_key.delete");
  const canUpdateApiKey = hasPermission("api_key.update");

  const canCreateApiKey = hasPermission("api_key.insert");

  const { enqueueSnackbar } = useSnackbar();

  const handleDelete = async () => {
    setLoading(true);
    try {
      const resp = await deleteApiKeyAction({ id: apiKeyIdForDelete! });

      if (!resp.ok) {
        throw new Error(resp.error.message);
      }
      if (!resp.data.ok) {
        throw new Error(resp.data.message);
      }
      setApiKeyIdForDelete(null);
      dialog.onFalse();
    } catch (error: any) {
      enqueueSnackbar(error.message, {
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setApiKeyIdForDelete(null);
    dialog.onFalse();
  };

  const ConfirmDeleteDialog = (
    <Dialog open={dialog.value} onClose={handleClose}>
      <DialogTitle>{t("dashboard.developers.deleteApiKeyTitle")}</DialogTitle>
      <DialogActions>
        <Button onClick={handleClose}>
          {t("dashboard.developers.cancel")}
        </Button>
        <Button
          disabled={!canDeleteApiKey}
          onClick={handleDelete}
          color="error"
          loading={loading}
          variant="contained"
          autoFocus
        >
          {t("dashboard.developers.delete")}
        </Button>
      </DialogActions>
    </Dialog>
  );

  return (
    <SettingsSection description={t("dashboard.developers.description")}>
      <Stack spacing={2} sx={{
        width: "100%"
      }}>
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
          <CreateApiKeyModal canCreateApiKey={!!canCreateApiKey} />
        </Stack>
        {apiKeys.length > 0 ? (
          <List disablePadding>
            {apiKeys?.map((key, index) => (
              <ListItem
                divider={index !== apiKeys.length - 1}
                sx={{ px: 0, py: 1.5, gap: 2, alignItems: "center" }}
                key={key.id}
              >
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    flexShrink: 0,
                    borderRadius: 1,
                    bgcolor: "background.neutral",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Iconify icon="solar:key-bold" width={22} />
                </Box>

                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="subtitle1"
                    component="p"
                    noWrap
                    data-testid="api-key-row-name"
                  >
                    {key.name}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: "center", flexWrap: "wrap", mt: 0.5 }}
                  >
                    {key.allowed_env_kinds?.length ? (
                      key.allowed_env_kinds.map((k) => (
                        <Chip
                          key={k}
                          size="small"
                          variant="outlined"
                          label={KIND_TARGET_LABELS[k as EnvTargetKind] ?? k}
                        />
                      ))
                    ) : environmentName ? (
                      <Chip size="small" variant="outlined" label={environmentName} />
                    ) : null}
                    <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                      {t("dashboard.developers.createdBy")}{" "}
                      {(key.created_by as unknown as { name: string })?.name ??
                        "Former member"}{" "}
                      · <LocalDate value={key.created_at} format="dateTime" />
                    </Typography>
                  </Stack>
                </Box>

                <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                  {canUpdateApiKey && (
                    <IconButton
                      onClick={() => setEditKeyId(key.api_key_id)}
                      size="small"
                    >
                      <Iconify icon="mdi:pencil" />
                    </IconButton>
                  )}
                  {canDeleteApiKey && (
                    <IconButton
                      onClick={() => {
                        setApiKeyIdForDelete(key.id);
                        dialog.onTrue();
                      }}
                      color="error"
                      size="small"
                    >
                      <Iconify icon="mdi:delete" />
                    </IconButton>
                  )}
                </Stack>
              </ListItem>
            ))}
          </List>
        ) : (
          <EmptyContent
            sx={{ height: "300px" }}
            title={t("dashboard.developers.emptyList")}
          />
        )}
        {ConfirmDeleteDialog}
        {editKeyId && app?.id && (
          <EditApiKeyModal
            open={!!editKeyId}
            onCloseAction={() => setEditKeyId(null)}
            apiKeyId={editKeyId}
            appId={app.id}
          />
        )}
      </Stack>
    </SettingsSection>
  );
};
