"use client";

/**
 * The Overview's secondary rail cards: the cross-skill topic rollup (linking
 * into Insights) and the no-telemetry inventory counts. Instructions,
 * commands and subagents have NO activation telemetry — they render as
 * inventory with an explicit note, never as fake zeros that read as unused.
 */
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useParams } from "next/navigation";
import { useTranslate } from "@outerlayer/locales";
import { RouterLink } from "@/routes/components";
import { appPaths } from "@/routes/paths";
import { useOptionalEnvContext, DEFAULT_ENV_NAME } from "@/context/env-context";
import type { ContextOverviewResponse } from "../../types";

export function OverviewTopicCard({ response }: { response: ContextOverviewResponse }) {
  const { t } = useTranslate();
  const params = useParams<{ orgName: string; appName: string }>();
  const envName = useOptionalEnvContext()?.selectedEnv.name ?? DEFAULT_ENV_NAME;
  if (response.topics.length === 0) return null;
  return (
    <Paper variant="outlined" data-testid="overview-topic-card">
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "baseline", justifyContent: "space-between", px: 2, py: 1.25, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Typography variant="subtitle2">{t("dashboard.context.overview.topicsTitle")}</Typography>
        <Link
          component={RouterLink}
          href={appPaths.insights.root(params.orgName, params.appName, envName)}
          variant="caption"
          sx={{ fontWeight: 600 }}
        >
          {t("dashboard.context.overview.topicsInsights")}
        </Link>
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", rowGap: 0.5, p: 1.5 }}>
        {response.topics.map((topic) => (
          <Chip
            key={topic.topicId}
            size="small"
            variant="outlined"
            label={`${topic.name} · ${topic.sessions}`}
            sx={{ height: 20 }}
          />
        ))}
      </Stack>
    </Paper>
  );
}

export function OverviewInventoryCard({ response }: { response: ContextOverviewResponse }) {
  const { t } = useTranslate();
  const { instructionScopes, commands, subagents } = response.inventory;
  if (instructionScopes === 0 && commands === 0 && subagents === 0) return null;
  const rows = [
    instructionScopes > 0
      ? t("dashboard.context.overview.inventoryInstructions", { count: instructionScopes })
      : null,
    commands > 0 ? t("dashboard.context.overview.inventoryCommands", { count: commands }) : null,
    subagents > 0 ? t("dashboard.context.overview.inventorySubagents", { count: subagents }) : null,
  ].filter((row): row is string => row !== null);
  return (
    <Paper variant="outlined" data-testid="overview-inventory-card">
      <Typography
        variant="subtitle2"
        sx={{ px: 2, py: 1.25, borderBottom: "1px solid", borderColor: "divider" }}
      >
        {t("dashboard.context.overview.inventoryTitle")}
      </Typography>
      <Stack spacing={0.5} sx={{ px: 2, py: 1.25 }}>
        {rows.map((row) => (
          <Typography key={row} variant="body2" sx={{ fontSize: 13 }}>
            {row}
          </Typography>
        ))}
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("dashboard.context.overview.inventoryNote")}
        </Typography>
      </Stack>
    </Paper>
  );
}
