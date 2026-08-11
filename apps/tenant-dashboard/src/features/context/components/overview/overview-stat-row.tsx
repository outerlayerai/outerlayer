"use client";

/**
 * The Overview's four stat tiles, on the shared StatCard idiom. Verdict
 * captions (active · quiet · never) appear only when verdicts are available;
 * a degraded analytics read renders coverage/activations as unavailable —
 * never as zero, which would misread as "nothing happened".
 */
import Box from "@mui/material/Box";
import { useTranslate } from "@outerlayer/locales";
import { StatCard } from "@/components/stat-card";
import { fNumber } from "@/utils/format-number";
import type { ContextOverviewResponse } from "../../types";
import {
  countMcpStatuses,
  countSkillStatuses,
  coverageDelta,
  coveragePct,
  percentDelta,
  verdictsAvailable,
  type OverviewDelta,
  type StatusCounts,
} from "./context-overview-model";

function toChange(delta: OverviewDelta | null, periodLabel: string) {
  return delta
    ? { glyph: delta.glyph, text: delta.text, sentiment: delta.sentiment, periodLabel }
    : undefined;
}

export function OverviewStatRow({ response }: { response: ContextOverviewResponse }) {
  const { t } = useTranslate();
  const verdicts = verdictsAvailable(response);
  const periodLabel = t("dashboard.context.overview.vsPrior", {
    range: t(`dashboard.context.overview.range.${response.range}`),
  });
  const noPrior = t("dashboard.context.overview.noPriorData");

  const countsCaption = (counts: StatusCounts) =>
    t("dashboard.context.overview.statusCaption", { ...counts });

  const skillCounts = countSkillStatuses(response.skills);
  const mcpCounts = countMcpStatuses(response.mcpServers);
  const skillTotal = response.skills.filter((r) => r.inRepo).length;
  const mcpTotal = response.mcpServers.filter((r) => r.inRepo).length;

  const activations = response.skills.reduce((sum, r) => sum + r.activations, 0);
  const priorActivations = response.skills.reduce((sum, r) => sum + r.priorActivations, 0);

  const pct = response.coverage
    ? coveragePct(response.coverage.sessions, response.coverage.sessionsWithSkill)
    : null;

  return (
    <Box
      data-testid="overview-stat-row"
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "repeat(2, 1fr)", md: "repeat(4, 1fr)" },
        gap: 1.5,
        mb: 1.5,
      }}
    >
      <StatCard
        label={t("dashboard.context.overview.tileSkills")}
        value={fNumber(skillTotal)}
        infoText={t("dashboard.context.overview.tileSkillsInfo")}
        caption={verdicts ? countsCaption(skillCounts) : undefined}
      />
      <StatCard
        label={t("dashboard.context.overview.tileMcp")}
        value={fNumber(mcpTotal)}
        infoText={t("dashboard.context.overview.tileMcpInfo")}
        caption={verdicts ? countsCaption(mcpCounts) : undefined}
      />
      <StatCard
        label={t("dashboard.context.overview.tileCoverage")}
        value={pct === null ? "" : `${pct.toFixed(0)}%`}
        infoText={t("dashboard.context.overview.tileCoverageInfo")}
        unavailableReason={
          response.coverage === null
            ? t("dashboard.context.overview.analyticsUnavailableShort")
            : pct === null
              ? t("dashboard.context.overview.noSessionsYet")
              : undefined
        }
        caption={pct === null ? undefined : t("dashboard.context.overview.coverageCaption")}
        change={
          response.coverage ? toChange(coverageDelta(response.coverage), periodLabel) : undefined
        }
        noPriorText={response.coverage && pct !== null ? noPrior : undefined}
      />
      <StatCard
        label={t("dashboard.context.overview.tileActivations")}
        value={fNumber(activations)}
        infoText={t("dashboard.context.overview.tileActivationsInfo")}
        unavailableReason={
          response.degraded ? t("dashboard.context.overview.analyticsUnavailableShort") : undefined
        }
        change={toChange(percentDelta(activations, priorActivations), periodLabel)}
        noPriorText={response.degraded ? undefined : noPrior}
      />
    </Box>
  );
}
