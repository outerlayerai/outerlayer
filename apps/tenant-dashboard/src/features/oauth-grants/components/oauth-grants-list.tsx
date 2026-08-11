"use client";

import { useState } from "react";
import { Box, Stack } from "@mui/system";
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
import { useSnackbar } from "notistack";
import { useTranslate } from "@outerlayer/locales";

import Iconify from "@/components/iconify";
import { LocalDate } from "@/components/local-date";
import { useBoolean } from "@/hooks/use-boolean";
import EmptyContent from "@/components/empty-content";
import { SettingsSection } from "@/components/settings-shell";

import { revokeOAuthGrantAction } from "../actions";
import type { OAuthGrant } from "../types";

type Props = {
  grants: OAuthGrant[];
};

export const OAuthGrantsList = ({ grants }: Props) => {
  const { t } = useTranslate();
  const { enqueueSnackbar } = useSnackbar();
  const dialog = useBoolean();
  const [sessionIdForRevoke, setSessionIdForRevoke] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRevoke = async () => {
    if (!sessionIdForRevoke) return;
    setLoading(true);
    try {
      const resp = await revokeOAuthGrantAction({ sessionId: sessionIdForRevoke });
      if (!resp.ok) {
        throw new Error(resp.error.message);
      }
      setSessionIdForRevoke(null);
      dialog.onFalse();
    } catch (error) {
      enqueueSnackbar(error instanceof Error ? error.message : "Unexpected error", {
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSessionIdForRevoke(null);
    dialog.onFalse();
  };

  return (
    <SettingsSection description={t("dashboard.developers.grants.description")}>
      <Stack spacing={2} sx={{ width: "100%" }}>
        {grants.length > 0 ? (
          <List disablePadding>
            {grants.map((grant, index) => (
              <ListItem
                divider={index !== grants.length - 1}
                sx={{ px: 0, py: 1.5, gap: 2, alignItems: "center" }}
                key={grant.sessionId}
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
                  <Iconify icon="solar:link-bold" width={22} />
                </Box>

                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle1" component="p" noWrap>
                    {grant.clientName ?? t("dashboard.developers.grants.unnamedClient")}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: "center", flexWrap: "wrap", mt: 0.5 }}
                  >
                    {grant.scopes.map((scope) => (
                      <Chip key={scope} size="small" variant="outlined" label={scope} />
                    ))}
                    <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                      {t("dashboard.developers.grants.connectedOn")}{" "}
                      <LocalDate value={grant.createdAt} format="dateTime" />
                    </Typography>
                  </Stack>
                </Box>

                <IconButton
                  onClick={() => {
                    setSessionIdForRevoke(grant.sessionId);
                    dialog.onTrue();
                  }}
                  color="error"
                  size="small"
                >
                  <Iconify icon="mdi:delete" />
                </IconButton>
              </ListItem>
            ))}
          </List>
        ) : (
          <EmptyContent
            sx={{ height: "300px" }}
            title={t("dashboard.developers.grants.emptyList")}
          />
        )}

        <Dialog open={dialog.value} onClose={handleClose}>
          <DialogTitle>{t("dashboard.developers.grants.revokeTitle")}</DialogTitle>
          <DialogActions>
            <Button onClick={handleClose}>{t("dashboard.developers.cancel")}</Button>
            <Button
              onClick={handleRevoke}
              color="error"
              loading={loading}
              variant="contained"
              autoFocus
            >
              {t("dashboard.developers.grants.revokeButton")}
            </Button>
          </DialogActions>
        </Dialog>
      </Stack>
    </SettingsSection>
  );
};
