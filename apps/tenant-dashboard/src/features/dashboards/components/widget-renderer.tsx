'use client';

/**
 * WidgetRenderer Component
 *
 * Accepts a Widget config, fetches data via useWidgetData,
 * and renders the appropriate visualization component.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Iconify from '@/components/iconify';
import { useWidgetData } from '../hooks/use-widget-data';
import { useDashboardContext } from './context';
import { useEnvContext } from '@/context/env-context';
import { WidgetChart } from './widget-chart';
import { WidgetStatCard } from './widget-stat-card';
import { WidgetRankingList } from './widget-ranking-list';
import Chart from '@/components/chart';
import type { Widget } from '../types';
import { resolveWidgetEnvironmentConfig } from '../types';

// ---------------------------------------------------------------------------
// Widget env resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a widget's effective env scope at query time:
 *  - `inherit` (default) — the widget follows the app-wide env selected via
 *    the header env switch (`EnvContext`). The query is scoped to that single
 *    env, and when the env is the app's default it also sweeps in legacy
 *    rows recorded with no environment.
 *  - `override` — the widget ignores the header env and uses its own env
 *    list verbatim. A multi-env list is a cross-env comparison; `isDefault`
 *    is irrelevant (legacy rows are never swept into a multi-env `IN (...)`).
 */
function resolveWidgetEnvScope(
  widget: Widget,
  selectedEnv: { name: string; isDefault: boolean },
): { environments: string[]; environmentIsDefault: boolean } {
  const config = resolveWidgetEnvironmentConfig(widget.environmentConfig);
  if (config.mode === 'override' && (config.environments?.length ?? 0) > 0) {
    return { environments: config.environments ?? [], environmentIsDefault: false };
  }
  // inherit — follow the header env switch (the canonical app-wide env).
  return {
    environments: [selectedEnv.name],
    environmentIsDefault: selectedEnv.isDefault,
  };
}

// ---------------------------------------------------------------------------
// useInView — triggers when element enters viewport (with 200px prefetch margin)
// ---------------------------------------------------------------------------

function useInView<T extends HTMLElement>(): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  return { ref, inView };
}

// ---------------------------------------------------------------------------
// DeleteButton — trash icon with confirmation popover
// ---------------------------------------------------------------------------

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const handleOpen = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget);
  }, []);

  const handleClose = useCallback(() => setAnchor(null), []);

  const handleConfirm = useCallback(() => {
    setAnchor(null);
    onConfirm();
  }, [onConfirm]);

  return (
    <>
      <IconButton size="small" onClick={handleOpen}>
        <Iconify icon="eva:trash-2-outline" width={18} />
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Stack spacing={1.5} sx={{ p: 2, maxWidth: 220 }}>
          <Typography variant="subtitle2">Delete widget?</Typography>
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>
            This action cannot be undone.
          </Typography>
          <Stack direction="row" spacing={1} sx={{
            justifyContent: "flex-end"
          }}>
            <Button size="small" onClick={handleClose}>
              Cancel
            </Button>
            <Button size="small" variant="contained" color="error" onClick={handleConfirm}>
              Delete
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// PanelBar — the widget's mono title bar (hairline-ruled, actions right)
// ---------------------------------------------------------------------------

function PanelBar({
  title,
  subheader,
  action,
}: {
  title: string;
  subheader?: string;
  action?: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        px: 2,
        py: 0.75,
        minHeight: 40,
        borderBottom: '1px solid',
        borderColor: 'divider',
        flexShrink: 0,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component="h3"
          noWrap
          sx={{
            fontFamily: (t) => t.typography.fontFamilyMonospace,
            fontSize: '0.6875rem',
            fontWeight: 600,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            color: 'text.secondary',
          }}
        >
          {title}
        </Typography>
        {subheader ? (
          <Typography variant="caption" noWrap sx={{ display: 'block', color: 'text.disabled' }}>
            {subheader}
          </Typography>
        ) : null}
      </Box>
      {action}
    </Box>
  );
}

/** Maps the dashboard time range to the delta row's named prior window. */
const PERIOD_LABELS: Record<string, string> = {
  '24h': 'vs prior 24h',
  '7d': 'vs prior 7d',
  '30d': 'vs prior 30d',
  '90d': 'vs prior 90d',
};

interface WidgetRendererProps {
  widget: Widget;
  onDelete?: (widgetId: string) => void;
}

export function WidgetRenderer({ widget, onDelete }: WidgetRendererProps) {
  const { timeRange, scope, appId } = useDashboardContext();
  const { selectedEnv } = useEnvContext();
  const { ref, inView } = useInView<HTMLDivElement>();
  const { orgName } = useParams<{ orgName: string }>();

  // Section headers render their title as a heading band and never fetch —
  // there is no data behind them. The hook below still runs (hooks can't be
  // conditional) but stays disabled so no request is ever made.
  const isSectionHeader = widget.metric === 'section_header';

  // Resolve the widget's env scope: inherit ⇒ header env (EnvContext),
  // override ⇒ the widget's own list.
  const envScope = resolveWidgetEnvScope(widget, selectedEnv);

  const config = {
    metric: widget.metric,
    visualization: widget.visualization,
    filters: widget.filters,
    groupBy: widget.groupBy,
    timeGranularity: widget.timeGranularity,
    scoreName: widget.scoreName,
    scoreNameB: widget.scoreNameB,
    environments: envScope.environments,
    environmentIsDefault: envScope.environmentIsDefault,
    // The header's App/Organization toggle — only fleet/PR metrics read it.
    scope,
  };

  const { data, error, isLoading, refresh } = useWidgetData(orgName, appId, config, { preset: timeRange }, { enabled: inView && !isSectionHeader });

  if (isSectionHeader) {
    return (
      <Box
        ref={ref}
        sx={{
          height: '100%',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 1,
          px: 0.5,
          pb: 0.5,
          borderBottom: (t) => `2px solid ${t.palette.divider}`,
        }}
      >
        <Typography variant="h5" component="h2" noWrap>
          {widget.title}
        </Typography>
        {onDelete ? <DeleteButton onConfirm={() => onDelete(widget.id)} /> : null}
      </Box>
    );
  }

  // Everything past this point is gated on `inView`, which only an
  // IntersectionObserver in a real browser can set — so no widget body ever
  // reaches server-rendered markup. That is why the number formatting below
  // (and in WidgetStatCard / WidgetRankingList) can use the ambient locale
  // directly: there is no server render for it to disagree with. Do not
  // "fix" those to the SSR-safe formatters; the rule they'd be satisfying
  // does not apply here.
  //
  // The loading, error, and no-data states below are deliberately local to a
  // widget rather than the shared page-level primitives: those render their own
  // Card (this is already one), and the error card is a live region — one per
  // widget would turn a single blip into a screenful of simultaneous alerts.

  // Not yet in viewport — show lightweight placeholder
  if (!inView || isLoading) {
    return (
      <Card ref={ref} sx={{ p: 2, height: '100%' }}>
        <Skeleton variant="text" width="60%" height={28} />
        <Skeleton variant="rectangular" height={200} sx={{ mt: 2, borderRadius: 1 }} />
      </Card>
    );
  }

  // Error state — only when there's nothing to show. A failed BACKGROUND
  // refresh (a transient 500 while polling, or on window refocus) must not
  // blank an already-rendered chart: keep serving the last good data — SWR
  // retries and the next successful revalidation replaces it.
  if (error && !data) {
    return (
      <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <PanelBar
          title={widget.title}
          action={onDelete ? <DeleteButton onConfirm={() => onDelete(widget.id)} /> : undefined}
        />
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            py: 4,
          }}
        >
          <Typography variant="body2" color="error" gutterBottom>
            Failed to load widget data
          </Typography>
          <Button size="small" onClick={refresh} startIcon={<Iconify icon="eva:refresh-fill" />}>
            Retry
          </Button>
        </Box>
      </Card>
    );
  }

  // Stat card visualization renders its own card
  if (widget.visualization === 'stat' && data?.type === 'stat') {
    return (
      <WidgetStatCard
        data={data}
        metric={widget.metric}
        periodLabel={PERIOD_LABELS[timeRange] ?? 'vs prior period'}
      />
    );
  }

  // Determine the inner visualization based on response type
  const renderContent = () => {
    if (data?.type === 'timeSeries') {
      return <WidgetChart data={data} visualization={widget.visualization} metric={widget.metric} />;
    }
    if (data?.type === 'ranking') {
      return <WidgetRankingList data={data} metric={widget.metric} />;
    }
    if (data?.type === 'scoreSummary') {
      // Render summary data inline (no wrapping Card/Grid — WidgetRenderer already provides a Card)
      const aggs = data.aggregations ?? [];
      if (aggs.length === 0) {
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>No score data available</Typography>
          </Box>
        );
      }
      const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2));
      return (
        <Stack spacing={1.5}>
          {aggs.map((agg) => {
            // Type-appropriate headline: a boolean score's mean is the share that
            // passed, so show it as a percentage and drop the trivial 0/1 min/max.
            const isBoolean = agg.dataType === 'boolean';
            return (
              <Box key={agg.name} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Stack direction="row" spacing={1} sx={{
                  alignItems: "center"
                }}>
                  <Typography variant="subtitle2">{agg.name}</Typography>
                  {agg.dataType ? <Chip label={agg.dataType} size="small" variant="outlined" /> : null}
                </Stack>
                <Stack direction="row" spacing={2} sx={{
                  alignItems: "center"
                }}>
                  {isBoolean ? (
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>True rate: {(agg.avgScore * 100).toFixed(1)}%</Typography>
                  ) : (
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>Avg: {fmt(agg.avgScore)}</Typography>
                  )}
                  <Typography variant="caption" sx={{
                    color: "text.secondary"
                  }}>Count: {agg.count.toLocaleString()}</Typography>
                  {!isBoolean && (
                    <>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>Min: {fmt(agg.minScore)}</Typography>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>Max: {fmt(agg.maxScore)}</Typography>
                    </>
                  )}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      );
    }
    if (data?.type === 'scoreHistogram') {
      // Render chart only (no wrapping Card — WidgetRenderer already provides one)
      const histData = data.data;
      const categories = histData?.type === 'numeric'
        ? histData.buckets.map((b) => b.bucket.toFixed(2))
        : histData?.categories.map((c) => c.label) ?? [];
      const series = [{
        name: 'Count',
        data: histData?.type === 'numeric'
          ? histData.buckets.map((b) => b.count)
          : histData?.categories.map((c) => c.count) ?? [],
      }];
      if (!histData || (histData.buckets.length === 0 && histData.categories.length === 0)) {
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>No distribution data available</Typography>
          </Box>
        );
      }
      return <Chart type="bar" series={series} options={{ xaxis: { categories }, yaxis: { title: { text: 'Count' } }, dataLabels: { enabled: false }, plotOptions: { bar: { borderRadius: 2, columnWidth: '60%' } }, tooltip: { y: { formatter: (val: number) => `${val} scores` } } }} height={280} />;
    }
    if (data?.type === 'scoreTrend') {
      // Render chart only (no wrapping Card — WidgetRenderer already provides one)
      const trendData = data.data;
      if (!trendData || trendData.points.length === 0) {
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>No trend data available</Typography>
          </Box>
        );
      }
      const filteredPoints = trendData.points.filter((p) => p.count > 0);
      const series = [{ name: widget.scoreName ?? 'Score', data: filteredPoints.map((p) => ({ x: new Date(p.timestamp).getTime(), y: p.avgScore })) }];
      return <Chart type="line" series={series} options={{ xaxis: { type: 'datetime' as const }, yaxis: { title: { text: 'Avg Score' }, labels: { formatter: (val: number) => val.toFixed(2) } }, stroke: { width: 2, curve: 'smooth' as const }, markers: { size: 3 }, tooltip: { y: { formatter: (val: number) => val.toFixed(2) } } }} height={280} />;
    }
    if (data?.type === 'scoreComparison') {
      if (data.scatter) {
        // Render scatter chart inline (no wrapping Card — WidgetRenderer already provides one)
        const scatterPoints = data.scatter.points;
        if (scatterPoints.length === 0) {
          return (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>No matched traces found</Typography>
            </Box>
          );
        }
        const series = [{ name: 'Matched traces', data: scatterPoints.map((p) => ({ x: p.scoreA, y: p.scoreB })) }];
        return (
          <Stack spacing={1}>
            <Chart type="scatter" series={series} options={{
              xaxis: { title: { text: data.scatter.nameA ?? widget.scoreName ?? 'Score A' }, tickAmount: 5, labels: { formatter: (val: string) => Number(val).toFixed(2) } },
              yaxis: { title: { text: data.scatter.nameB ?? widget.scoreNameB ?? 'Score B' }, tickAmount: 5, labels: { formatter: (val: number) => val.toFixed(2) } },
              markers: { size: 5 },
              grid: { xaxis: { lines: { show: true } } },
              tooltip: { y: { formatter: (val: number) => val.toFixed(2) } },
            }} height={280} />
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                textAlign: "center"
              }}>
              {data.scatter.totalMatched.toLocaleString()} matched traces
            </Typography>
          </Stack>
        );
      }
      if (data.comparison) {
        // Render heatmap from comparison data with proper axis labels
        const labelsA = [...new Set(data.comparison.matrix.map((c) => c.labelA))].sort();
        const labelsB = [...new Set(data.comparison.matrix.map((c) => c.labelB))].sort();
        const heatmapSeries = labelsA.map((labelA) => ({
          name: labelA,
          data: labelsB.map((labelB) => {
            const cell = data.comparison!.matrix.find((c) => c.labelA === labelA && c.labelB === labelB);
            return { x: labelB, y: cell?.count ?? 0 };
          }),
        }));
        return (
          <Stack spacing={1}>
            <Chart type="heatmap" series={heatmapSeries} options={{
              dataLabels: { enabled: true },
              plotOptions: { heatmap: { colorScale: { ranges: [{ from: 0, to: 0, color: '#f5f5f5' }] }, radius: 2 } },
              xaxis: { position: 'bottom', title: { text: data.comparison.nameB ?? widget.scoreNameB ?? 'Score B' } },
              yaxis: { title: { text: data.comparison.nameA ?? widget.scoreName ?? 'Score A' } },
              tooltip: { y: { formatter: (val: number) => `${val} traces` } },
            }} height={300} />
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                textAlign: "center"
              }}>
              {data.comparison.totalMatched.toLocaleString()} matched traces
            </Typography>
          </Stack>
        );
      }
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            Select two scores to compare
          </Typography>
        </Box>
      );
    }
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 200,
        }}
      >
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          No data available
        </Typography>
      </Box>
    );
  };

  // Build a descriptive subtitle for score widgets so users know which score(s) they're looking at
  const scoreSubheader = (() => {
    if (widget.metric === 'score_histogram' || widget.metric === 'score_trend') {
      return widget.scoreName ?? undefined;
    }
    if (widget.metric === 'score_comparison' && widget.scoreName && widget.scoreNameB) {
      return `${widget.scoreName} vs ${widget.scoreNameB}`;
    }
    return undefined;
  })();

  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelBar
        title={widget.title}
        subheader={scoreSubheader}
        action={onDelete ? <DeleteButton onConfirm={() => onDelete(widget.id)} /> : undefined}
      />
      <Box sx={{ px: 2, pt: 1.5, pb: 1, flex: 1, minHeight: 0 }}>
        {renderContent()}
      </Box>
    </Card>
  );
}
