"use client";

import { useEffect } from "react";
import { Alert, Button } from "@mui/material";
import posthog from "posthog-js";
import { useTranslate } from "@outerlayer/locales";
import { LinkRepositoryModal } from "@/components/link-repository";
import { useAppContext } from "@/lib/app-shell/app-context";
import { useRepoConnect } from "../hooks";

/**
 * The soft half of the onboarding v2 repo gate. The setup card locks steps
 * behind "link your repo", but trace ingestion doesn't check git state — a
 * user can wire the SDK with just an API key and start sending traces. When
 * that happens we must never hide their data, so the trace pages render
 * normally and THIS banner carries the remaining nudge: persistent (not
 * dismissible) until a repository is actually linked.
 *
 * Mounted app-wide next to the checklist; renders nothing until we KNOW the
 * app has traces but no linked repo.
 */
export function RepoGateBanner() {
  const { t } = useTranslate();
  const { app, hasCreatedTrace } = useAppContext();
  const appId = app?.id ?? "";

  const {
    setup,
    mutate,
    gitConnected,
    repoLinked,
    linkRepoDialog,
    openNextDialog,
  } = useRepoConnect(hasCreatedTrace ? appId : "", "banner");

  const visible = Boolean(appId) && hasCreatedTrace && Boolean(setup) && !repoLinked;

  useEffect(() => {
    if (visible) posthog.capture("onboarding_banner_viewed");
  }, [visible]);

  if (!visible) return null;

  return (
    <>
      <Alert
        severity="warning"
        variant="outlined"
        sx={{ mb: 2, flexShrink: 0, py: 0.25, alignItems: "center" }}
        action={
          <Button color="warning" size="small" variant="text" onClick={openNextDialog}>
            {t("dashboard.gettingStarted.banner.cta")}
          </Button>
        }
      >
        {t("dashboard.gettingStarted.banner.message")}
      </Alert>

      {appId && gitConnected && (
        <LinkRepositoryModal
          appId={appId}
          open={linkRepoDialog.value}
          onClose={() => {
            linkRepoDialog.onFalse();
            // Revalidate so the banner disappears the moment the repo links.
            void mutate();
          }}
        />
      )}
    </>
  );
}