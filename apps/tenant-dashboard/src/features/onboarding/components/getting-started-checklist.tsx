"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import posthog from "posthog-js";
import {
  Box,
  Card,
  IconButton,
  LinearProgress,
  Link as MuiLink,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import Iconify from "@/components/iconify";
import { useTranslate } from "@outerlayer/locales";
import { useAppContext } from "@/lib/app-shell/app-context";
import { appPaths, paths } from "@/routes/paths";
import { useSelectedEnv } from "@/hooks/environments/use-selected-env";
import {
  buildChecklistSteps,
  checklistProgress,
  type ChecklistStatus,
  type ChecklistStepId,
} from "../checklist";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<ChecklistStatus>;
  });

const dismissKey = (appId: string) => `agentmark:onboarding-checklist-dismissed:${appId}`;
const collapsedKey = (appId: string) => `agentmark:onboarding-checklist-collapsed:${appId}`;

/**
 * The unified getting-started checklist. A persistent, dismissible progress
 * tracker mounted app-wide that auto-hides once every step is done. Step 1
 * ("create your first app") is always pre-checked — the endowed-progress
 * effect: a list that starts at 1/4 is finished more often than one at 0/4.
 */
export function GettingStartedChecklist() {
  const { t } = useTranslate();
  const { app, hasCreatedTrace } = useAppContext();
  const { orgName, appName } = useParams<{ orgName: string; appName: string }>();
  const selectedEnv = useSelectedEnv();
  const appId = app?.id ?? "";

  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!appId) return;
    try {
      setDismissed(localStorage.getItem(dismissKey(appId)) === "1");
    } catch {
      // localStorage unavailable (private mode) — treat as not dismissed.
    }
  }, [appId]);

  // Collapsed vs expanded, persisted per app. First appearance is expanded; once
  // the user collapses it, it stays a pill on later visits.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!appId) return;
    try {
      setCollapsed(localStorage.getItem(collapsedKey(appId)) === "1");
    } catch {
      // localStorage unavailable — default to expanded.
    }
  }, [appId]);

  // Only fetch when the checklist could actually render: after the first trace
  // (the panel owns the pre-trace phase) and while not dismissed. The render
  // gate below enforces the same conditions for display, but gating the SWR
  // *key* here is what stops the endpoint's three count queries (one hits
  // ClickHouse) from firing on every app-page load and every window refocus
  // (`revalidateOnFocus`) for users who will never see this card. Once it's
  // live, refocus revalidation still keeps the progress fresh as steps complete.
  const shouldFetch =
    Boolean(orgName) && Boolean(appId) && hasCreatedTrace && !dismissed;
  const { data } = useSWR(
    shouldFetch
      ? `/api/orgs/${orgName}/apps/${appId}/onboarding/checklist?appId=${appId}`
      : null,
    fetcher,
    // live: git-connect / deploy completes in another tab; refocus keeps the
    // progress fresh as steps complete elsewhere.
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );

  // Only surface the checklist AFTER the first trace has landed — pre-trace,
  // trace-family pages render nothing (see `useSetupGate`) rather than
  // double-stacking onboarding surfaces. Once `hasCreatedTrace` is true the
  // checklist takes over the remaining steps.
  if (!appId || dismissed || !data || !hasCreatedTrace) return null;

  const links = {
    // The general settings tab hosts the connect-git flow, and "see your
    // data" lands on the agents sessions list.
    repo: appPaths.developers.general(orgName, appName, selectedEnv.name),
    apiKeys: appPaths.developers.apiKeys(orgName, appName, selectedEnv.name),
    traces: appPaths.agents.sessions(orgName, appName, selectedEnv.name),
    members: `${paths.orgs.org.settings.root(orgName)}/members`,
  };
  const steps = buildChecklistSteps(data, links);
  const progress = checklistProgress(steps);

  // Nothing left to nudge — get out of the way.
  if (progress.complete) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(dismissKey(appId), "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
    posthog.capture("onboarding_checklist_dismissed", {
      done: progress.done,
      total: progress.total,
    });
  };

  const setCollapsedPersisted = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey(appId), next ? "1" : "0");
    } catch {
      /* ignore */
    }
    posthog.capture(
      next ? "onboarding_checklist_collapsed" : "onboarding_checklist_expanded",
      { done: progress.done, total: progress.total },
    );
  };

  // A floating bottom-right widget so the checklist doesn't displace page
  // content. speedDial z-index keeps it above content but below modals/drawers.
  const wrapperSx = {
    position: "fixed",
    bottom: { xs: 16, sm: 24 },
    right: { xs: 16, sm: 24 },
    zIndex: (theme: Theme) => theme.zIndex.speedDial,
    maxWidth: "calc(100vw - 32px)",
  } as const;

  if (collapsed) {
    return (
      <Box sx={wrapperSx} data-testid="getting-started-widget">
        <Card
          role="button"
          aria-label={t("dashboard.gettingStarted.checklist.title")}
          onClick={() => setCollapsedPersisted(false)}
          sx={{
            p: 1.25,
            display: "flex",
            alignItems: "center",
            gap: 1.25,
            cursor: "pointer",
          }}
        >
          <Typography variant="caption" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
            Setup · {progress.done}/{progress.total}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={progress.percent}
            sx={{ width: 72, height: 6, borderRadius: 1 }}
          />
        </Card>
      </Box>
    );
  }

  return (
    <Box sx={{ ...wrapperSx, width: { xs: "calc(100vw - 32px)", sm: 340 } }} data-testid="getting-started-widget">
      <Card sx={{ p: 2.5 }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between"
          }}>
          <Typography variant="subtitle1">
            {t("dashboard.gettingStarted.checklist.title")}
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{
            alignItems: "center"
          }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {progress.done} / {progress.total}
            </Typography>
            <IconButton
              size="small"
              onClick={() => setCollapsedPersisted(true)}
              aria-label="collapse checklist"
            >
              <Iconify icon="mdi:chevron-down" width={18} />
            </IconButton>
            <Tooltip title={t("dashboard.gettingStarted.checklist.dismiss")}>
              <IconButton size="small" onClick={handleDismiss} aria-label="dismiss checklist">
                <Iconify icon="mdi:close" width={18} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        <LinearProgress
          variant="determinate"
          value={progress.percent}
          sx={{ my: 1.5, height: 6, borderRadius: 1 }}
        />
        <Stack spacing={1}>
          {steps.map((step) => (
            <Stack key={step.id} direction="row" spacing={1.5} sx={{
              alignItems: "center"
            }}>
              <Iconify
                icon={step.done ? "mdi:check-circle" : "mdi:circle-outline"}
                width={20}
                sx={{ color: step.done ? "success.main" : "text.disabled", flexShrink: 0 }}
              />
              <Typography
                variant="body2"
                sx={{
                  color: step.done ? "text.secondary" : "text.primary",
                  textDecoration: step.done ? "line-through" : "none",
                  flexGrow: 1,
                }}
              >
                {t(`dashboard.gettingStarted.checklist.${step.id as ChecklistStepId}.label`)}
              </Typography>
              {!step.done && step.href && (
                <MuiLink
                  component={Link}
                  href={step.href}
                  variant="body2"
                  sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}
                  onClick={() =>
                    posthog.capture("onboarding_checklist_step_clicked", { step: step.id })
                  }
                >
                  {t(`dashboard.gettingStarted.checklist.${step.id as ChecklistStepId}.cta`)}
                  <Iconify icon="mdi:arrow-right" width={16} />
                </MuiLink>
              )}
            </Stack>
          ))}
        </Stack>
      </Card>
    </Box>
  );
}
