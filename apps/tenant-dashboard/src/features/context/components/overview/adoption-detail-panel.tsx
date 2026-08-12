"use client";

/**
 * The Overview's side drawer — one artifact's drill-down, sliding in from
 * the right edge, keyed off the `?skill=` / `?server=` URL param the caller
 * owns. Deliberately scrim-free: the tables stay interactive underneath, so
 * clicking through rows swaps the drawer content in place (the comparison
 * flow a modal backdrop would kill). Content reuses the drill-down reads and
 * the shared adoption widgets; the trend is zero-filled over the fixed
 * lookback so a silent tail stays visible.
 */
import { useMemo } from "react";
import { useParams } from "next/navigation";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Slide from "@mui/material/Slide";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { HEADER } from "@/layouts/config-layout";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import { LocalDate } from "@/components/local-date";
import { RouterLink } from "@/routes/components";
import { appPaths } from "@/routes/paths";
import { useOptionalEnvContext, DEFAULT_ENV_NAME } from "@/context/env-context";
import { useContextMcpDrilldown, useContextSkillDrilldown } from "../../hooks";
import type { ContextOverviewResponse, OverviewMcpRow, OverviewSkillRow } from "../../types";
import { parseAdoptionTimestamp } from "../adoption-time";
import { buildTrendSeries } from "../context-skill-drilldown";
import {
  AdoptionSessionRow,
  AdoptionStat,
  TrendSparkline,
  useRelativeTimeLabel,
} from "../context-adoption-widgets";

const SESSION_ROWS = 8;
const TOOL_ROWS = 10;
const SPARK_WIDTH = 320;

export interface AdoptionDetailSelection {
  kind: "skill" | "mcp";
  name: string;
}

interface AdoptionDetailPanelProps {
  appId: string;
  response: ContextOverviewResponse;
  selection: AdoptionDetailSelection;
  onClose: () => void;
  /** Opens the Files view on the artifact's file (SKILL.md / mcp.json). */
  onOpenFile: (path: string) => void;
  /** `YYYY-MM-DD` "today" for the zero-filled trend (timezone-stable). */
  today: string;
}

export function AdoptionDetailPanel({
  appId,
  response,
  selection,
  onClose,
  onOpenFile,
  today,
}: AdoptionDetailPanelProps) {
  const { t } = useTranslate();
  const relTime = useRelativeTimeLabel();
  const params = useParams<{ orgName: string; appName: string }>();
  const envName = useOptionalEnvContext()?.selectedEnv.name ?? DEFAULT_ENV_NAME;

  const isSkill = selection.kind === "skill";
  const skillRow: OverviewSkillRow | undefined = isSkill
    ? response.skills.find((r) => r.skillName === selection.name)
    : undefined;
  const mcpRow: OverviewMcpRow | undefined = !isSkill
    ? response.mcpServers.find((r) => r.serverName === selection.name)
    : undefined;

  const skillDrill = useContextSkillDrilldown(appId, isSkill ? selection.name : null);
  const mcpDrill = useContextMcpDrilldown(appId, !isSkill ? selection.name : null);
  const drill = isSkill ? skillDrill : mcpDrill;

  const trendSeries = useMemo(() => {
    if (isSkill) {
      const data = skillDrill.data;
      if (!data) return [];
      return buildTrendSeries(
        data.trend.map((p) => ({ day: p.day, value: p.activations })),
        data.lookbackDays,
        today,
      );
    }
    const data = mcpDrill.data;
    if (!data) return [];
    return buildTrendSeries(
      data.trend.map((p) => ({ day: p.day, value: p.calls })),
      data.lookbackDays,
      today,
    );
  }, [isSkill, skillDrill.data, mcpDrill.data, today]);

  const rangeLabel = t(`dashboard.context.overview.range.${response.range}`);
  const rangeValue = isSkill ? (skillRow?.activations ?? 0) : (mcpRow?.calls ?? 0);
  const lookbackValue = isSkill ? (skillRow?.lookbackActivations ?? 0) : (mcpRow?.lookbackCalls ?? 0);
  const sessionsValue = isSkill ? (skillRow?.sessions ?? 0) : (mcpRow?.sessions ?? 0);
  const lastUsedAt = isSkill ? (skillRow?.lastActivatedAt ?? null) : (mcpRow?.lastUsedAt ?? null);
  const lastUsed = response.degraded
    ? "—"
    : (relTime(lastUsedAt) ?? t("dashboard.context.tree.lastUsedNever"));
  const stat = (value: number) => (response.degraded ? "—" : value);

  const filePath = isSkill
    ? skillRow?.scopePath !== null && skillRow?.scopePath !== undefined
      ? `${skillRow.scopePath === "" ? ".outerlayer" : `${skillRow.scopePath}/.outerlayer`}/skills/${skillRow.skillName}/SKILL.md`
      : null
    : (mcpRow?.configPath ?? null);

  const sessions = isSkill
    ? (skillDrill.data?.sessions ?? []).map((s) => ({
        traceId: s.traceId,
        title: s.title,
        count: s.activations,
        at: s.lastActivatedAt,
      }))
    : (mcpDrill.data?.sessions ?? []).map((s) => ({
        traceId: s.traceId,
        title: s.title,
        count: s.calls,
        at: s.lastUsedAt,
      }));

  return (
    <Slide direction="left" in appear mountOnEnter>
      <Paper
        elevation={8}
        square
        data-testid="overview-detail-panel"
        sx={{
          position: "fixed",
          top: HEADER.HEIGHT,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: "92vw",
          zIndex: (theme) => theme.zIndex.drawer,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid",
          borderColor: "divider",
          overflow: "hidden",
        }}
      >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", px: 2, pt: 1.75, pb: 1.25, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}
      >
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography
            variant="overline"
            sx={{ color: "text.disabled", display: "block", lineHeight: 1.5 }}
          >
            {t(isSkill ? "dashboard.context.overview.panelSkill" : "dashboard.context.overview.panelServer")}
          </Typography>
          <Typography variant="h6" sx={{ lineHeight: 1.3, overflowWrap: "anywhere" }}>
            {selection.name}
          </Typography>
          {filePath && (
            <Typography variant="caption" sx={{ color: "text.secondary", fontFamily: "monospace", overflowWrap: "anywhere" }}>
              {filePath}
            </Typography>
          )}
          {isSkill && skillRow?.scopePath === null && skillRow.inRepo && (
            // The name-keyed join caveat: same-named skills across scopes
            // share this one usage figure.
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
              {t("dashboard.context.overview.panelScopeCaveat")}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={t("dashboard.context.overview.panelClose")}
          data-testid="overview-detail-close"
        >
          <Iconify icon="mdi:close" width={18} />
        </IconButton>
      </Stack>

      <Stack spacing={2} sx={{ p: 2, flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", rowGap: 1 }}>
          <AdoptionStat
            value={stat(rangeValue)}
            label={t(
              isSkill
                ? "dashboard.context.overview.panelStatActivations"
                : "dashboard.context.overview.panelStatCalls",
              { range: rangeLabel },
            )}
            testId="overview-panel-range"
          />
          <AdoptionStat
            value={stat(lookbackValue)}
            label={t("dashboard.context.overview.panelStatTotal", { days: response.lookbackDays })}
            testId="overview-panel-total"
          />
          <AdoptionStat
            value={stat(sessionsValue)}
            label={t("dashboard.context.overview.panelStatSessions")}
            testId="overview-panel-sessions"
          />
          <AdoptionStat
            value={lastUsed}
            label={t("dashboard.context.overview.panelStatLastUsed")}
            testId="overview-panel-last-used"
          />
        </Stack>

        {drill.isLoading && (
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {t("dashboard.context.tree.drilldownLoading")}
          </Typography>
        )}
        {!drill.isLoading && (drill.error || !drill.data) && (
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {t("dashboard.context.tree.drilldownUnavailable")}
          </Typography>
        )}
        {!drill.isLoading && !drill.error && drill.data && (
          <>
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
                {t(
                  isSkill
                    ? "dashboard.context.tree.drilldownTrend"
                    : "dashboard.context.overview.panelTrendCalls",
                  { days: drill.data.lookbackDays },
                )}
              </Typography>
              <TrendSparkline series={trendSeries} unit={isSkill ? "activations" : "calls"} width={SPARK_WIDTH} />
            </Box>
            {!isSkill && mcpDrill.data && mcpDrill.data.tools.length > 0 && (
              <Box>
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
                  {t("dashboard.context.tree.mcpToolsUsed", { count: mcpDrill.data.tools.length })}
                </Typography>
                <Stack spacing={0.25}>
                  {mcpDrill.data.tools.slice(0, TOOL_ROWS).map((tool) => (
                    <Stack key={tool.tool} direction="row" spacing={1} sx={{ alignItems: "baseline", minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {tool.tool}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.disabled", flexShrink: 0 }}>
                        {tool.totalCalls}× ·{" "}
                        <LocalDate value={parseAdoptionTimestamp(tool.lastUsedAt)} format="monthDay" absent="" />
                      </Typography>
                    </Stack>
                  ))}
                  {mcpDrill.data.tools.length > TOOL_ROWS && (
                    <Typography variant="caption" sx={{ color: "text.disabled" }}>
                      {t("dashboard.context.tree.mcpToolsMore", { count: mcpDrill.data.tools.length - TOOL_ROWS })}
                    </Typography>
                  )}
                </Stack>
              </Box>
            )}
            {sessions.length > 0 && (
              <Box>
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
                  {t("dashboard.context.tree.drilldownSessions")}
                </Typography>
                <Stack spacing={0.25}>
                  {sessions.slice(0, SESSION_ROWS).map((s) => (
                    <AdoptionSessionRow
                      key={s.traceId}
                      label={s.title || s.traceId.slice(0, 12)}
                      suffix={
                        <>
                          <LocalDate value={parseAdoptionTimestamp(s.at)} format="monthDay" absent="" />
                          {s.count > 1 ? ` · ${s.count}×` : ""}
                        </>
                      }
                      href={appPaths.agents.session(params.orgName, params.appName, envName, s.traceId)}
                    />
                  ))}
                </Stack>
              </Box>
            )}
            {isSkill && skillDrill.data && skillDrill.data.topics.length > 0 && (
              <Box>
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.5 }}>
                  {t("dashboard.context.tree.drilldownTopics")}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", rowGap: 0.5 }}>
                  {skillDrill.data.topics.map((topic) => (
                    <Chip
                      key={topic.topicId}
                      size="small"
                      variant="outlined"
                      label={`${topic.name} · ${topic.sessions}`}
                      sx={{ height: 20 }}
                    />
                  ))}
                </Stack>
              </Box>
            )}
          </>
        )}

        <Stack direction="row" spacing={2}>
          {filePath && (
            <Link
              component="button"
              type="button"
              variant="caption"
              onClick={() => onOpenFile(filePath)}
              data-testid="overview-panel-open-file"
              sx={{ fontWeight: 600 }}
            >
              {t("dashboard.context.overview.panelOpenInFiles")}
            </Link>
          )}
          <Link
            component={RouterLink}
            href={appPaths.agents.sessions(params.orgName, params.appName, envName)}
            variant="caption"
            sx={{ fontWeight: 600 }}
          >
            {t("dashboard.context.overview.panelAllSessions")}
          </Link>
        </Stack>
      </Stack>
      </Paper>
    </Slide>
  );
}
