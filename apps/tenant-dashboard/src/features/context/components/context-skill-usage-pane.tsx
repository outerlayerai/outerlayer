"use client";

/**
 * Detail pane for a selected skill directory: a Files | Usage tab pair.
 * Files lists the skill's own files (selecting one opens the editor); Usage
 * holds everything the tree row only whispers — the stat headline, the
 * zero-filled activation trend, the activating sessions, and the task topics.
 * Usage is the default tab: the tree's file rows already open files, so
 * selecting the dir itself is the ask-about-usage gesture.
 */
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { LocalDate } from "@/components/local-date";
import { parseAdoptionTimestamp } from "./adoption-time";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import { appPaths } from "../../../routes/paths";
import { useOptionalEnvContext, DEFAULT_ENV_NAME } from "../../../context/env-context";
import { useAppContext } from "@/lib/app-shell/app-context";
import { useContextSkillDrilldown } from "../hooks";
import { buildTrendSeries } from "./context-skill-drilldown";
import type { SkillActivation } from "./context-skill-adoption";
import {
  AdoptionSessionRow,
  AdoptionStat,
  TrendSparkline,
  useRelativeTimeLabel,
} from "./context-adoption-widgets";

/** Sessions shown in the Usage tab; the API already caps and orders recent-first. */
const SESSION_ROWS = 8;
/** Sparkline drawing width — the pane is wide, so the trend gets real space. */
const SPARK_WIDTH = 420;

interface SkillFileRow {
  path: string;
  /** Path relative to the skill dir (`SKILL.md`, `references/style.md`). */
  name: string;
}

/**
 * The whole right-pane composition for a selected skill dir. `activation` is
 * the skill's overlay row (`undefined` = never activated once the overlay
 * loaded); `overlayLoaded` false means the stats are unknown, not zero.
 */
export function SkillDetailPane({
  skillName,
  dirPath,
  files,
  activation,
  overlayLoaded,
  recentDays,
  lookbackDays,
  onSelectFile,
}: {
  skillName: string;
  dirPath: string;
  files: SkillFileRow[];
  activation: SkillActivation | undefined;
  overlayLoaded: boolean;
  recentDays: number;
  lookbackDays: number;
  onSelectFile: (path: string) => void;
}) {
  const { t } = useTranslate();
  const [tab, setTab] = useState<"files" | "usage">("usage");
  return (
    <Box sx={{ p: 3, height: 1, overflow: "auto" }} data-testid="skill-detail-pane">
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "baseline", mb: 1 }}>
        <Typography variant="h6">{skillName}</Typography>
        <Typography variant="caption" sx={{ color: "text.secondary", fontFamily: "monospace" }}>
          {dirPath}/
        </Typography>
      </Stack>
      <Tabs value={tab} onChange={(_e, next: "files" | "usage") => setTab(next)} sx={{ mb: 2 }}>
        <Tab value="files" label={t("dashboard.context.view.tabFiles")} data-testid="skill-tab-files" />
        <Tab value="usage" label={t("dashboard.context.view.tabUsage")} data-testid="skill-tab-usage" />
      </Tabs>
      {tab === "files" ? (
        <Stack spacing={0.25} data-testid="skill-files-list">
          {files.map((file) => (
            <Stack
              key={file.path}
              direction="row"
              spacing={1}
              onClick={() => onSelectFile(file.path)}
              sx={{
                alignItems: "center",
                px: 1,
                py: 0.5,
                borderRadius: 1,
                cursor: "pointer",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Iconify icon="mdi:file-document-outline" width={16} sx={{ color: "text.secondary" }} />
              <Typography variant="body2" sx={{ fontSize: 13 }}>
                {file.name}
              </Typography>
            </Stack>
          ))}
        </Stack>
      ) : (
        <SkillUsageTab
          skillName={skillName}
          activation={activation}
          overlayLoaded={overlayLoaded}
          recentDays={recentDays}
          lookbackDays={lookbackDays}
        />
      )}
    </Box>
  );
}

function SkillUsageTab({
  skillName,
  activation,
  overlayLoaded,
  recentDays,
  lookbackDays,
}: {
  skillName: string;
  activation: SkillActivation | undefined;
  overlayLoaded: boolean;
  recentDays: number;
  lookbackDays: number;
}) {
  const { t } = useTranslate();
  const { app } = useAppContext();
  const appId = app?.id ?? "";
  const params = useParams<{ orgName: string; appName: string }>();
  const envName = useOptionalEnvContext()?.selectedEnv.name ?? DEFAULT_ENV_NAME;
  const relTime = useRelativeTimeLabel();
  const { data, isLoading, error } = useContextSkillDrilldown(appId, skillName);

  const series = useMemo(() => {
    if (!data) return [];
    const points = data.trend.map((p) => ({ day: p.day, value: p.activations }));
    return buildTrendSeries(points, data.lookbackDays, new Date().toISOString().slice(0, 10));
  }, [data]);

  // Stats come from the overlay row the tree already fetched; "—" while the
  // overlay hasn't loaded (unknown ≠ zero), red "never" when it loaded and
  // the skill has no row.
  const stat = (value: number) => (overlayLoaded ? value : "—");
  const lastUsed = !overlayLoaded
    ? "—"
    : activation
      ? (relTime(activation.lastActivatedAt) ?? "—")
      : t("dashboard.context.tree.lastUsedNever");
  return (
    <Stack spacing={2} data-testid={`skill-usage-${skillName}`}>
      <Stack direction="row" spacing={4}>
        <AdoptionStat
          value={stat(activation?.recentActivations ?? 0)}
          label={t("dashboard.context.view.usageStatRecent", { days: recentDays })}
          testId="skill-usage-recent"
        />
        <AdoptionStat
          value={stat(activation?.totalActivations ?? 0)}
          label={t("dashboard.context.view.usageStatTotal", { days: lookbackDays })}
          testId="skill-usage-total"
        />
        <AdoptionStat
          value={stat(activation?.totalSessions ?? 0)}
          label={t("dashboard.context.view.usageStatSessions")}
          testId="skill-usage-sessions"
        />
        <AdoptionStat
          value={
            overlayLoaded && !activation ? (
              <Box component="span" sx={{ color: "error.main" }}>{lastUsed}</Box>
            ) : (
              lastUsed
            )
          }
          label={t("dashboard.context.view.usageStatLastUsed")}
          testId="skill-usage-last-used"
        />
      </Stack>
      {isLoading && (
        <Typography variant="caption" sx={{ color: "text.disabled" }}>
          {t("dashboard.context.tree.drilldownLoading")}
        </Typography>
      )}
      {!isLoading && (error || !data) && (
        <Typography variant="caption" sx={{ color: "text.disabled" }}>
          {t("dashboard.context.tree.drilldownUnavailable")}
        </Typography>
      )}
      {!isLoading && !error && data && (
        <>
          <Box>
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
              {t("dashboard.context.tree.drilldownTrend", { days: data.lookbackDays })}
            </Typography>
            <TrendSparkline series={series} unit="activations" width={SPARK_WIDTH} />
          </Box>
          {data.sessions.length > 0 && (
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.25 }}>
                {t("dashboard.context.tree.drilldownSessions")}
              </Typography>
              <Stack spacing={0.25}>
                {data.sessions.slice(0, SESSION_ROWS).map((s) => (
                  <AdoptionSessionRow
                    key={s.traceId}
                    label={s.title || s.traceId.slice(0, 12)}
                    suffix={
                      <>
                        <LocalDate value={parseAdoptionTimestamp(s.lastActivatedAt)} format="monthDay" absent="" />
                        {s.activations > 1 ? ` · ${s.activations}×` : ""}
                      </>
                    }
                    href={appPaths.agents.session(params.orgName, params.appName, envName, s.traceId)}
                  />
                ))}
              </Stack>
            </Box>
          )}
          {data.topics.length > 0 && (
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.5 }}>
                {t("dashboard.context.tree.drilldownTopics")}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", rowGap: 0.5 }}>
                {data.topics.map((topic) => (
                  <Chip
                    key={topic.topicId}
                    size="small"
                    variant="outlined"
                    data-testid="skill-usage-topic"
                    label={`${topic.name} · ${topic.sessions}`}
                    sx={{ height: 20 }}
                  />
                ))}
              </Stack>
            </Box>
          )}
          {data.sessions.length === 0 && data.topics.length === 0 && (
            <Typography variant="caption" sx={{ color: "text.disabled" }}>
              {t("dashboard.context.tree.drilldownEmpty", { days: data.lookbackDays })}
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}
