"use client";

import { Box, Stack } from "@mui/system";
import { Grid, Typography } from "@mui/material";
import { useParams, useRouter } from "next/navigation";
import { CreateAppModal } from "./create-app-modal";
import { useTranslate } from "@outerlayer/locales";
import { useAppRoles } from "@/lib/adapters/use-app-roles";
import { useAuthContext } from "@/lib/adapters/use-auth-context";
import { usePopover } from '@/components/custom-popover';
import { useBoolean } from "@/hooks/use-boolean";
import { useState } from "react";
import EmptyContent from '@/components/empty-content';
import { EmptyAppAccess } from "@/components/empty-app-access";
import { useSnackbar } from "notistack";
import { startGitConnectAction } from "@/lib/git-connect/start-git-connect-action";
import { AppCard } from "./app-card";
import { paths } from "@/routes/paths";
import { AppSettingsMenu } from "./app-settings-menu";
import { DeleteAppModal } from "./delete-app-modal";
import { RenameAppModal } from "./rename-app-modal";
import { LinkRepositoryModal } from "@/components/link-repository";

import type { AppWithGitConnection } from "../types";

type Props = {
  apps: AppWithGitConnection[];
};

export const AppList = ({ apps }: Props) => {
  const [appForAction, setAppForAction] = useState<AppWithGitConnection>();

  const { orgName } = useParams();

  const linkRepoDialog = useBoolean();

  const renameDialog = useBoolean();

  const { user } = useAuthContext();

  // App-scoped roles restrict the member to a subset of the org's apps.
  const { isAppScoped, isLoading: appRolesLoading } = useAppRoles();

  const router = useRouter();
  const { enqueueSnackbar } = useSnackbar();

  const popover = usePopover();

  const dialog = useBoolean();

  const { t: translate } = useTranslate();

  const t = (key: string) => translate(`app.${key}`);

  const canCreateApp = user?.permissions?.some(
    (p) => p.permission === "app.insert"
  );

  const canDeleteApp = user?.permissions?.some(
    (p) => p.permission === "app.delete"
  );

  const canRenameApp = user?.permissions?.some(
    (p) => p.permission === "app.update"
  );

  const canLinkGit = user?.permissions?.some(
    (p) => p.permission === "git_connection.update"
  );

  const handleOpenConnectProvider = async (appId: string) => {
    setAppForAction(undefined);
    // Route through the gateway's signed-state minter (via the shared
    // server action). The dashboard OAuth callbacks verify the HMAC
    // signature + cross-check tenant/provider before persisting the
    // connection, so building this URL inline is not a substitute.
    const result = await startGitConnectAction({ appId, provider: "github" });
    if (!result.ok) {
      enqueueSnackbar(result.error.message, { variant: "error" });
      return;
    }
    if (!result.data.ok) {
      if (result.data.errorCode === "git_connect_not_configured") {
        enqueueSnackbar(
          t("connectProviderUnavailable") ??
            "Git provider connect is temporarily unavailable. Contact support.",
          { variant: "error" },
        );
        return;
      }
      enqueueSnackbar(result.data.message, { variant: "error" });
      return;
    }
    router.push(result.data.authorizationUrl);
  };

  return (
    <>
      <Stack spacing={3}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between"
          }}>
          <Typography variant="h5" component="h1">
            {t("title")}
          </Typography>
          {canCreateApp && (
            <Box>
              <CreateAppModal />
            </Box>
          )}
        </Stack>
        <Box>
          <Grid container spacing={2}>
            {!apps.length && !appRolesLoading && isAppScoped && (
              <EmptyAppAccess sx={{ mt: 3 }} />
            )}
            {!apps.length && !appRolesLoading && !isAppScoped && (
              <EmptyContent sx={{ mt: 3 }} filled title={t("emptyList")} />
            )}
            {apps.map((app) => (
              <Grid size={{ xs: 12, sm: 6, lg: 4 }} key={app.id}>
                <AppCard
                  app={app}
                  canDeleteApp={!!canDeleteApp}
                  canRenameApp={!!canRenameApp}
                  canLinkGit={!!canLinkGit}
                  onSettingsClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    popover.onOpen(e);
                    setAppForAction(app);
                  }}
                  t={t}
                  onCardClick={() => {
                    router.push(
                      paths.orgs.org.apps.app.root(orgName as string, app.name)
                    );
                  }}
                />
              </Grid>
            ))}
          </Grid>
        </Box>
      </Stack>
      <AppSettingsMenu
        app={appForAction}
        onClose={popover.onClose}
        open={popover.open}
        canDeleteApp={Boolean(canDeleteApp)}
        canRenameApp={Boolean(canRenameApp)}
        canLinkGit={Boolean(canLinkGit)}
        onDeleteApp={dialog.onTrue}
        onRenameApp={renameDialog.onTrue}
        onLinkRepository={linkRepoDialog.onTrue}
        onConnectProvider={handleOpenConnectProvider}
        t={t}
      />
      <DeleteAppModal
        appId={appForAction?.id || ""}
        appName={appForAction?.name || ""}
        open={dialog.value}
        onClose={() => {
          dialog.onFalse();
          popover.onClose();
          setAppForAction(undefined);
        }}
        t={t}
      />
      <RenameAppModal
        appId={appForAction?.id || ""}
        displayName={appForAction?.display_name}
        identifier={appForAction?.name || ""}
        open={renameDialog.value}
        onClose={() => {
          renameDialog.onFalse();
          popover.onClose();
          setAppForAction(undefined);
        }}
        t={t}
      />
      <LinkRepositoryModal
        appId={appForAction?.id || ""}
        open={linkRepoDialog.value}
        onClose={() => {
          linkRepoDialog.onFalse();
          popover.onClose();
        }}
        translationPrefix="app"
      />
    </>
  );
};
