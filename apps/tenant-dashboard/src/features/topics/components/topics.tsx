"use client";

/**
 * Topics page — the active topic map for an environment.
 *
 * Per facet (Task / Steering / Issues): ranked topics with live SESSION
 * counts and share (a subagent transcript credits its root session, so counts
 * match the drill-down), a Generate/Regenerate action, cold-start guidance
 * below the summary floor, and drill-down — clicking a topic opens the
 * Sessions page scoped to that topic.
 */

import { useCallback, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import type { ApexOptions } from "apexcharts";
import { useTranslate } from "@outerlayer/locales";
import { useSetupGate } from "@/lib/app-shell/use-setup-gate";
import type { TopicFacet, TopicsList } from "@/lib/analytics/topics/topics-shared";
import { generationFloorForFacet } from "@/lib/analytics/topics/topics-shared";
import { useGenerateTopics } from "../hooks/use-topics";
import { LocalDate } from "@/components/local-date";
import { formatLocalDate } from "@/utils/format-date";

// react-apexcharts touches `window` — load client-only to avoid SSR errors.
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

const NO_MATCH_LABEL = "No match";

const METRICS_SNAPSHOT_NOTE =
  "Computed from the traces sampled at the last generation — regenerate to refresh.";

/**
 * Cost is denominated per SESSION, matching the Sessions column: a session that
 * fans out to subagents records their spend on their own transcripts, and this
 * figure sums the whole tree. Averaging over member traces instead would both
 * drop that spend and divide by a denominator the Sessions column disagrees
 * with, understating a fanned-out topic roughly two-fold.
 */
const COST_NOTE = `Average model spend per session, including everything its subagents spent. ${METRICS_SNAPSHOT_NOTE}`;

/**
 * Wall-clock lifetime of the session, NOT responsiveness: it spans the first to
 * the last recorded span, so a session left open overnight reads as hours of
 * idle. Named "duration" for exactly that reason — as "latency" the number
 * invites a performance reading it cannot support.
 */
const DURATION_NOTE = `Wall-clock time from a session's first to last activity, including time spent idle. ${METRICS_SNAPSHOT_NOTE}`;

// Agent sessions run for hours — "53270.7s" reads as noise, "14.8h" reads
// as a number. Sub-90s values keep second/millisecond precision.
const fmtMs = (n: number) =>
  n >= 3_600_000
    ? `${(n / 3_600_000).toFixed(1)}h`
    : n >= 90_000
      ? `${(n / 60_000).toFixed(1)}m`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}s`
        : n > 0
          ? `${Math.round(n)}ms`
          : "—";
const fmtCost = (n: number) =>
  n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "—";
const fmtBucket = (bucket: string, granularity: "hour" | "day") => {
  // bucket is "YYYY-MM-DD HH:00:00" (UTC) → an hour label ("2 PM") for an
  // hourly axis, or a date label ("Jun 12") once the axis is daily. Axis
  // categories are plain strings, so this formats directly rather than going
  // through `LocalDate`; the chart is client-only, so the visitor's own zone is
  // the one in play either way.
  return formatLocalDate(
    `${bucket.replace(" ", "T")}Z`,
    granularity === "day" ? "monthDay" : "hour",
  ) ?? bucket;
};

export interface TopicsProps {
  appId: string;
  facet: TopicFacet;
  /** The active topic map, seeded by the React Server Component (RSC) read. Null only alongside `error`. */
  topics: TopicsList | null;
  /** Set when the RSC read failed (permission denial, ClickHouse unavailable). */
  error: { message: string; status?: number } | null;
}

export const Topics = ({ appId, facet, topics, error }: TopicsProps) => {
  const { t } = useTranslate();
  const { pending: setupPending, showSetup } = useSetupGate();

  const { generating, lastOutcome, generate } = useGenerateTopics(appId, facet);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    setGenerateError(null);
    try {
      await generate();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed");
    }
  }, [generate]);

  // Facet switch is a navigation: the RSC page re-reads the map for the new
  // facet and this component remounts (keyed by facet at the page level), so
  // there is no client-side facet state to carry across the switch.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setFacet = useCallback(
    (next: TopicFacet) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("facet", next);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Drill-down: open the Sessions list scoped to this topic. The Sessions list
  // reads topicId/topicFacet from the URL and shows the ROOT sessions the
  // topic's counts are made of. Topics render under .../env/<env>/insights;
  // Sessions under .../env/<env>/agents/sessions.
  const openTopicSessions = useCallback(
    (topicId: string, topicName?: string) => {
      const base = pathname.replace(/\/insights$/, "/agents/sessions");
      const qs = new URLSearchParams({ topicId, topicFacet: facet });
      if (topicName) qs.set("topicName", topicName);
      router.push(`${base}?${qs.toString()}`);
    },
    [pathname, router, facet],
  );

  if (setupPending) return null;
  if (showSetup) return null;

  const hasMap = (topics?.mapVersion ?? 0) > 0;
  // Both numbers come from the server so the page renders exactly the check
  // generation runs: samplableCount is computed by generation's own sample
  // predicate, and required is the floor in effect (default or override).
  // Deriving either client-side is how the counter and the floor drift apart.
  const summariesCollected = topics?.samplableCount ?? 0;
  const requiredSummaries = topics?.required ?? generationFloorForFacet(facet);
  const canGenerate = summariesCollected >= requiredSummaries;

  // Steering clusters are recurring corrections, not runs: the per-generation
  // outcome snapshots (errors / cost / latency) describe the sessions the
  // correction appeared in, not the correction itself — and a dollar figure
  // beside a correction invites a "this much was wasted" reading the session
  // cost can't support. The recurrence count (Sessions) is the receipt, so the
  // outcome columns are dropped for steering.
  const showOutcomeMetrics = facet !== "steering";

  // Steering mines full-tier message text, so a tenant whose capture ceiling is
  // below `full` never accrues steering rows. The tier rides the steering
  // response only; when it's set and below `full`, explain the empty tab
  // instead of rendering a permanently-blank table.
  const steeringNeedsFullTier =
    facet === "steering" &&
    topics?.captureTier != null &&
    topics.captureTier !== "full";

  const freshness = topics?.generatedAt ? (
    <>
      Map v{topics.mapVersion} · generated{" "}
      <LocalDate value={`${topics.generatedAt.replace(" ", "T")}Z`} format="monthDayTime" />
      {!canGenerate
        ? ` · ${summariesCollected}/${requiredSummaries} toward next regeneration`
        : ""}
    </>
  ) : null;

  return (
    <Box data-testid="topics-page">
      <PageHeader
        title={t("dashboard.sidebar.topics")}
        caption={freshness}
        actions={
          <>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={facet}
              onChange={(_e, value: TopicFacet | null) => value && setFacet(value)}
              aria-label="Topic facet"
            >
              <ToggleButton value="task" data-testid="facet-task">
                Task
              </ToggleButton>
              <ToggleButton value="steering" data-testid="facet-steering">
                Steering
              </ToggleButton>
              <ToggleButton value="issues" data-testid="facet-issues">
                Issues
              </ToggleButton>
            </ToggleButtonGroup>
            {/* The disabled state needs its reason on the surface: with a map
                already rendered below, a silently-dead Regenerate reads as a
                bug. The count is current-extraction-version summaries, so
                during a re-extraction drain it climbs on its own. */}
            <Tooltip
              title={
                !canGenerate
                  ? `Needs ${requiredSummaries} summaries at the current extraction version (${summariesCollected} so far). Summaries accrue automatically as sessions are analyzed and re-analyzed.`
                  : ""
              }
            >
              <span>
                <Button
                  variant="contained"
                  onClick={handleGenerate}
                  loading={generating}
                  disabled={generating || !canGenerate}
                  data-testid="generate-topics"
                >
                  {hasMap ? "Regenerate topics" : "Generate topics"}
                </Button>
              </span>
            </Tooltip>
          </>
        }
      />

      <Stack spacing={2}>
        {generateError ? <Alert severity="error">{generateError}</Alert> : null}
        {lastOutcome?.status === "not_enough_data" ? (
          <Alert severity="info" data-testid="not-enough-data">
            Not enough facet summaries yet: {lastOutcome.sampleSize} of{" "}
            {lastOutcome.required} required before topics can be generated.
          </Alert>
        ) : null}
        {lastOutcome?.status === "no_clusters" ? (
          <Alert severity="info" data-testid="no-clusters">
            Clustering ran over {lastOutcome.sampleSize} summaries but found no
            distinct topics yet. The previous map is unchanged — try again once
            more traces accumulate.
          </Alert>
        ) : null}
        {/* A load error with NO data replaces the body — never the cold-start
            "No topics yet" card, which would misread a transient failure as an
            empty account. `ErrorState`, not `EmptyState`: retry, not "nothing
            here yet", is the honest offer. */}
        {error && !topics ? (
          <ErrorState
            data-testid="topics-error-state"
            title="Couldn't load topics"
            description={error.message}
            onRetry={() => router.refresh()}
          />
        ) : steeringNeedsFullTier ? (
          <EmptyState
            data-testid="topics-steering-tier-gate"
            title="Steering needs full-content capture"
            description={
              <>
                Steering clusters the corrections developers type mid-session, which
                lives in message text. This environment&apos;s tenant captures at the
                &ldquo;{topics!.captureTier}&rdquo; tier, so that text is never stored
                and no steering topics can form. Raise the capture tier to full to
                turn this on.
              </>
            }
          />
        ) : !hasMap ? (
          <EmptyState
            data-testid="topics-empty-state"
            title="No topics yet"
            description={
              <>
                Topics group this environment&apos;s traces into recurring
                patterns. Traces are summarized and embedded continuously; once
                at least {requiredSummaries} {facet} summaries exist, generate
                the first topic map.
              </>
            }
            // A progress readout toward the floor, not a way past it — the
            // action slot stays free for an actual CTA.
            meta={
              <Typography variant="caption" color="text.secondary">
                {summariesCollected} of {requiredSummaries} summaries collected
              </Typography>
            }
          />
        ) : (
          <Stack spacing={2}>
            <TopicsTrend topics={topics!} />
            <Card>
              <Table size="small" data-testid="topics-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Topic</TableCell>
                    <TableCell align="right" width={90}>
                      Sessions
                    </TableCell>
                    <TableCell width={180}>Share</TableCell>
                    {/* Outcome metrics are snapshots from the last generation
                        (sessions classified since then don't move them), unlike
                        the live Sessions/Share columns. */}
                    {showOutcomeMetrics ? (
                      <>
                        <TableCell align="right" width={90}>
                          <Tooltip title={COST_NOTE}>
                            <span>Avg cost</span>
                          </Tooltip>
                        </TableCell>
                        <TableCell align="right" width={90}>
                          <Tooltip title={DURATION_NOTE}>
                            <span>Avg duration</span>
                          </Tooltip>
                        </TableCell>
                      </>
                    ) : null}
                    <TableCell align="center" width={124}>
                      Trend
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {topics!.topics.map((topic) => (
                    <TableRow
                      key={topic.topicId}
                      hover
                      sx={{ cursor: "pointer" }}
                      onClick={() => openTopicSessions(topic.topicId, topic.name)}
                      data-testid={`topic-row-${topic.topicId}`}
                    >
                      <TableCell sx={{ maxWidth: 420 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {topic.name}
                        </Typography>
                        {topic.description ? (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: "block" }}
                          >
                            {topic.description}
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell align="right">{topic.sessionCount}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <Box sx={{ flexGrow: 1 }}>
                            <LinearProgress
                              variant="determinate"
                              value={Math.round(topic.share * 100)}
                            />
                          </Box>
                          <Typography variant="caption" color="text.secondary">
                            {(topic.share * 100).toFixed(0)}%
                          </Typography>
                        </Stack>
                      </TableCell>
                      {showOutcomeMetrics ? (
                        <>
                          <TableCell align="right">{fmtCost(topic.avgCostUsd)}</TableCell>
                          <TableCell align="right">{fmtMs(topic.avgLatencyMs)}</TableCell>
                        </>
                      ) : null}
                      <TableCell align="center">
                        <Sparkline
                          data={topic.trend}
                          days={topics!.trendDays}
                          granularity={topics!.trendBucket}
                          testId={`topic-trend-${topic.topicId}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {topics!.noMatchCount > 0 ? (
                    <TableRow
                      hover
                      sx={{ cursor: "pointer" }}
                      onClick={() => openTopicSessions("no_match", NO_MATCH_LABEL)}
                      data-testid="topic-row-no-match"
                    >
                      <TableCell sx={{ maxWidth: 420 }}>
                        <Typography variant="body2" color="text.secondary">
                          {NO_MATCH_LABEL}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: "block" }}
                        >
                          Outliers that fit no topic — where new topics form. A
                          growing bucket means it&apos;s time to regenerate.
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" color="text.secondary">
                          {topics!.noMatchCount}
                        </Typography>
                      </TableCell>
                      <TableCell colSpan={showOutcomeMetrics ? 3 : 1} />
                      <TableCell align="center">
                        <Sparkline
                          data={topics!.noMatchTrend}
                          days={topics!.trendDays}
                          granularity={topics!.trendBucket}
                          testId="topic-trend-no-match"
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </Card>
          </Stack>
        )}
      </Stack>
    </Box>
  );
};

/** Topics-over-time: stacked-area of each topic's session volume per bucket. */
function TopicsTrend({ topics }: { topics: TopicsList }) {
  if (topics.trendDays.length === 0) return null;
  const series = [
    ...topics.topics.map((topic) => ({ name: topic.name, data: topic.trend })),
    ...(topics.noMatchTrend.some((n) => n > 0)
      ? [{ name: NO_MATCH_LABEL, data: topics.noMatchTrend }]
      : []),
  ];
  // Nothing to plot if every series is flat-zero (e.g. all traces same day).
  if (series.every((s) => s.data.every((n) => n === 0))) return null;

  const options: ApexOptions = {
    chart: {
      type: "area",
      stacked: true,
      toolbar: { show: false },
      fontFamily: "inherit",
    },
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "gradient", gradient: { opacityFrom: 0.55, opacityTo: 0.08 } },
    xaxis: {
      categories: topics.trendDays.map((b) => fmtBucket(b, topics.trendBucket)),
      tickAmount: Math.min(7, topics.trendDays.length),
      axisTicks: { show: false },
      axisBorder: { show: false },
    },
    yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` } },
    legend: { position: "top", horizontalAlign: "left" },
    grid: { borderColor: "rgba(145,158,171,0.2)", strokeDashArray: 3 },
    tooltip: { shared: true },
  };

  return (
    <Card sx={{ p: 2 }} data-testid="topics-trend">
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Topics over time
      </Typography>
      <ReactApexChart type="area" height={240} series={series} options={options} />
    </Card>
  );
}

/**
 * Inline per-row volume trend. An SVG polyline (not a per-row ApexChart, so a
 * 70-topic table stays cheap) over the same hourly buckets as the aggregate
 * chart above. A flat/short series draws a dashed baseline rather than a
 * misleading spike.
 */
function Sparkline({
  data,
  days,
  granularity,
  testId,
}: {
  data: number[];
  days: string[];
  granularity: "hour" | "day";
  testId: string;
}) {
  const w = 108;
  const h = 28;
  const pad = 3;
  const first = data[0];
  const isFlat =
    data.length < 2 || first === undefined || data.every((n) => n === first);

  if (isFlat) {
    return (
      <Box
        component="svg"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="No trend data"
        data-testid={testId}
        sx={{ display: "block", mx: "auto", color: "text.disabled" }}
      >
        <line
          x1={pad}
          y1={h / 2}
          x2={w - pad}
          y2={h / 2}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </Box>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const n = data.length;
  const xAt = (i: number) => pad + (i / (n - 1)) * (w - 2 * pad);
  const yAt = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const line = data.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  const lastVal = data[n - 1] ?? 0;
  const unit = granularity === "day" ? "day" : "hr";
  const peakLabel = `Peak ${max}/${unit} over ${days.length} ${granularity === "day" ? "days" : "hours"}`;

  return (
    <Tooltip title={peakLabel}>
      <Box
        component="svg"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={peakLabel}
        data-testid={testId}
        sx={{ display: "block", mx: "auto", color: "primary.main" }}
      >
        <polygon points={area} fill="currentColor" fillOpacity={0.12} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={xAt(n - 1)} cy={yAt(lastVal)} r={2} fill="currentColor" />
      </Box>
    </Tooltip>
  );
}
