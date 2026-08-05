"use client";

import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import posthog from "posthog-js";
import { useTranslate } from "@outerlayer/locales";
import { useSnackbar } from "@/components/snackbar";
import { useBoolean } from "@/hooks/use-boolean";
import { startGitConnectAction } from "@/lib/git-connect/start-git-connect-action";
import type { OnboardingSetupState } from "./checklist";

const checklistFetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<OnboardingSetupState>;
  });

/**
 * Shared state + wiring for the "link your repo" gate — consumed by the
 * post-trace soft banner (`RepoGateBanner`).
 *
 * Owns: the onboarding setup-state SWR (one endpoint drives the gate, the
 * key step, and the checklist), the link-repo dialog boolean, and the
 * connect handler that mints the signed OAuth URL via the gateway (the same
 * wiring the Files placeholder uses).
 *
 * `revalidateOnFocus` matters here: the GitHub OAuth round-trip and the
 * scaffold/editor work all happen in other tabs/windows, so refocusing this
 * tab is exactly when state went stale.
 */
export function useRepoConnect(appId: string, surface: string) {
  const { t } = useTranslate();
  const router = useRouter();
  const { enqueueSnackbar } = useSnackbar();
  const { orgName } = useParams<{ orgName: string }>();
  const linkRepoDialog = useBoolean();

  const { data: setup, mutate } = useSWR(
    orgName && appId
      ? `/api/orgs/${orgName}/apps/${appId}/onboarding/checklist?appId=${appId}`
      : null,
    checklistFetcher,
    // live: git-connect completes in another tab; refocus is the invalidation
    // signal (the OAuth round-trip and scaffold/editor work happen elsewhere).
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );

  const gitConnected = setup?.hasGitConnection ?? false;
  const repoLinked = setup?.hasRepoLinked ?? false;

  /**
   * Mint the signed OAuth URL via the gateway and navigate. Errors surface
   * as toasts so the user is never stuck on a dead button.
   */
  const connectGitHub = async (targetAppId: string) => {
    posthog.capture("onboarding_repo_provider_selected", {
      surface,
      provider: "github",
    });
    const result = await startGitConnectAction({ appId: targetAppId, provider: "github" });
    if (!result.ok) {
      enqueueSnackbar(result.error.message, { variant: "error" });
      return;
    }
    if (!result.data.ok) {
      if (result.data.errorCode === "git_connect_not_configured") {
        enqueueSnackbar(t("dashboard.gettingStarted.repo.connectUnavailable"), {
          variant: "error",
        });
        return;
      }
      enqueueSnackbar(
        result.data.message || t("dashboard.gettingStarted.repo.connectFailed"),
        { variant: "error" },
      );
      return;
    }
    router.push(result.data.authorizationUrl);
  };

  /** Open the link-repo dialog, or start the GitHub connect flow, per the current git state. */
  const openNextDialog = () => {
    if (gitConnected) {
      linkRepoDialog.onTrue();
      posthog.capture("onboarding_repo_link_opened", { surface });
    } else {
      posthog.capture("onboarding_repo_connect_opened", { surface });
      void connectGitHub(appId);
    }
  };

  return {
    setup,
    mutate,
    gitConnected,
    repoLinked,
    linkRepoDialog,
    openNextDialog,
  };
}
