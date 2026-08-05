'use client';

// ---------------------------------------------------------------------------
// DoraMetricsView Component
//
// Main orchestrator for the DORA metrics overview. Renders a time range
// selector and four metric cards in a responsive grid, with loading, error,
// and empty states. Includes trend charts and app rankings table.
// ---------------------------------------------------------------------------

import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import { useDoraApps } from '@/hooks/dora-metrics/use-dora-apps';
import type { DoraApp } from '@/hooks/dora-metrics/use-dora-apps';
import { useDoraMetrics } from '@/hooks/dora-metrics/use-dora-metrics';
import { DORA_METRIC_CONFIGS } from '@/lib/dora-metrics/thresholds';
import type { DoraMetricsResponse, DoraTimeRange } from '@/lib/dora-metrics/types';

import { DoraAppRankings } from './dora-app-rankings';
import { DoraCollectionHealthBanner } from './dora-collection-health-banner';
import { DoraEmptyState } from './dora-empty-state';
import type { LoadHistoricalStatus } from './dora-empty-state';
import { DoraMetricCard } from './dora-metric-card';
import { DoraTrendCharts } from './dora-trend-charts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_RANGE_LABELS: Record<DoraTimeRange, string> = {
  '7d': '7 Days',
  '30d': '30 Days',
  '90d': '90 Days',
};

const TIME_RANGE_OPTIONS: DoraTimeRange[] = ['7d', '30d', '90d'];

/** Maps from DORA_METRIC_CONFIGS key to the response metrics field name. */
const METRIC_KEYS: Record<string, keyof DoraMetricsResponse['metrics']> = {
  deployment_frequency: 'deploymentFrequency',
  lead_time: 'leadTime',
  change_failure_rate: 'changeFailureRate',
  mttr: 'mttr',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DoraMetricsView() {
  const [timeRange, setTimeRange] = useState<DoraTimeRange>('30d');
  const [appId, setAppId] = useState<string | null>(null);
  const [loadHistoricalStatus, setLoadHistoricalStatus] = useState<LoadHistoricalStatus>('idle');

  const { apps } = useDoraApps();
  const { data, error, isLoading, isEmpty, refresh } = useDoraMetrics(timeRange, appId);

  const handleTimeRangeChange = (_event: React.MouseEvent<HTMLElement>, value: DoraTimeRange | null) => {
    if (value) setTimeRange(value);
  };

  const handleLoadHistorical = async () => {
    setLoadHistoricalStatus('loading');
    try {
      const res = await fetch('/api/platform-admin/dora-metrics/backfill', { method: 'POST' });
      if (res.ok || res.status === 409) {
        setLoadHistoricalStatus('done');
        refresh();
      } else {
        setLoadHistoricalStatus('error');
      }
    } catch {
      setLoadHistoricalStatus('error');
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box>
      {/* Header */}
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          mb: 3
        }}>
        <Typography variant="h4">DORA Metrics</Typography>

        <Stack direction="row" spacing={2} sx={{
          alignItems: "center"
        }}>
          <Autocomplete<DoraApp>
            size="small"
            options={apps}
            getOptionLabel={(option) => option.name}
            value={apps.find((a) => a.id === appId) ?? null}
            onChange={(_event, newValue) => setAppId(newValue?.id ?? null)}
            renderInput={(params) => (
              <TextField {...params} placeholder="All Services" variant="outlined" />
            )}
            sx={{ minWidth: 250 }}
          />

          {/* The environment is a property of THIS deployment (resolved
              server-side from DORA_ENVIRONMENT), never a client choice. */}
          {data?.environment && (
            <Chip
              label={data.environment === 'staging' ? 'Staging' : 'Production'}
              color={data.environment === 'staging' ? 'warning' : 'primary'}
              variant="outlined"
              size="small"
              aria-label="Deployment environment"
            />
          )}

          <ToggleButtonGroup
            value={timeRange}
            exclusive
            onChange={handleTimeRangeChange}
            size="small"
            aria-label="Time range"
          >
            {TIME_RANGE_OPTIONS.map((option) => (
              <ToggleButton key={option} value={option}>
                {TIME_RANGE_LABELS[option]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Stack>
      </Stack>
      {/* Collection pipeline health — a dead pipeline must never look like
          "no deployments happened" */}
      <DoraCollectionHealthBanner />
      {/* Loading state */}
      {isLoading && (
        <Grid container spacing={3}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Grid size={{ xs: 12, sm: 6, md: 3 }} key={i}>
              <Card sx={{ p: 3, height: '100%' }}>
                <Stack spacing={1.5}>
                  <Skeleton width="60%" />
                  <Skeleton variant="rectangular" height={40} />
                  <Skeleton width="40%" />
                  <Skeleton width="30%" />
                </Stack>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
      {/* Error state */}
      {!isLoading && error && (
        <Alert severity="error">
          {error instanceof SyntaxError
            ? 'Failed to load DORA metrics — the server returned an unexpected response. Try refreshing the page.'
            : error.message}
        </Alert>
      )}
      {/* Empty state */}
      {!isLoading && !error && isEmpty && (
        <DoraEmptyState
          isPolling={isEmpty}
          onLoadHistorical={handleLoadHistorical}
          loadHistoricalStatus={loadHistoricalStatus}
        />
      )}
      {/* Metric cards */}
      {!isLoading && !error && !isEmpty && data && (
        <Grid container spacing={3}>
          {DORA_METRIC_CONFIGS.map((config) => {
            const metricKey = METRIC_KEYS[config.key];
            if (!metricKey || !data) return null;
            const metric = data.metrics[metricKey];
            return (
              <Grid size={{ xs: 12, sm: 6, md: 3 }} key={config.key}>
                <DoraMetricCard
                  title={config.title}
                  metric={metric}
                  formatValue={config.formatValue}
                  higherIsBetter={config.higherIsBetter}
                  explanation={config.explanation}
                  sourceUrl={config.sourceUrl}
                />
              </Grid>
            );
          })}
        </Grid>
      )}
      {/* Trend charts — below metric cards */}
      {!isLoading && !error && !isEmpty && data && (
        <Box sx={{ mt: 4 }}>
          <DoraTrendCharts timeRange={timeRange} appId={appId} />
        </Box>
      )}
      {/* Rankings table — below trend charts */}
      {!isLoading && !error && !isEmpty && data && (
        <Box sx={{ mt: 4 }}>
          <DoraAppRankings timeRange={timeRange} onAppSelect={(id) => setAppId(id)} />
        </Box>
      )}
    </Box>
  );
}
