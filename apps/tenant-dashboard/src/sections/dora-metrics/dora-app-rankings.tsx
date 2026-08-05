'use client';

// ---------------------------------------------------------------------------
// DoraAppRankings Component
//
// MUI Table with sortable columns showing per-app DORA metric rankings.
// Clicking a row optionally navigates to the app detail view.
// ---------------------------------------------------------------------------

import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardHeader from '@mui/material/CardHeader';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Typography from '@mui/material/Typography';

import { useDoraRankings } from '@/hooks/dora-metrics/use-dora-rankings';
import { DORA_METRIC_CONFIGS } from '@/lib/dora-metrics/thresholds';
import type { DoraMetricType, DoraTimeRange, DoraAppRanking } from '@/lib/dora-metrics/types';

import { DoraPerformanceBadge } from './dora-performance-badge';

interface DoraAppRankingsProps {
  timeRange: DoraTimeRange;
  onAppSelect?: (serviceId: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps DoraMetricType (snake_case) to DoraAppRanking['metrics'] keys (camelCase). */
const RANKING_METRIC_KEYS: Record<DoraMetricType, keyof DoraAppRanking['metrics']> = {
  deployment_frequency: 'deploymentFrequency',
  lead_time: 'leadTime',
  change_failure_rate: 'changeFailureRate',
  mttr: 'mttr',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DoraAppRankings({ timeRange, onAppSelect }: DoraAppRankingsProps) {
  const [sortBy, setSortBy] = useState<DoraMetricType>('deployment_frequency');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { data, isLoading, error } = useDoraRankings(timeRange, sortBy, sortOrder);

  const handleSort = (metric: DoraMetricType) => {
    if (sortBy === metric) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(metric);
      setSortOrder('desc');
    }
  };

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  if (isLoading) {
    return (
      <Card>
        <CardHeader title="Service Rankings" />
        <Box sx={{ p: 3 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height={48} sx={{ mb: 1 }} />
          ))}
        </Box>
      </Card>
    );
  }

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <Card>
        <CardHeader title="Service Rankings" />
        <Box sx={{ p: 3 }}>
          <Typography color="error">{error.message}</Typography>
        </Box>
      </Card>
    );
  }

  // -------------------------------------------------------------------------
  // Empty state — don't render when there are no rankings
  // -------------------------------------------------------------------------

  const rankings = data?.rankings ?? [];

  if (rankings.length === 0) {
    return null;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Card>
      <CardHeader title="Service Rankings" subheader="Compare DORA metrics across platform services" />
      <TableContainer>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Service</TableCell>
              {DORA_METRIC_CONFIGS.map((config) => (
                <TableCell key={config.key} align="right">
                  <TableSortLabel
                    active={sortBy === config.key}
                    direction={sortBy === config.key ? sortOrder : 'desc'}
                    onClick={() => handleSort(config.key)}
                  >
                    {config.title}
                  </TableSortLabel>
                </TableCell>
              ))}
              <TableCell align="right">Deployments</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rankings.map((row) => (
              <TableRow
                key={row.serviceId}
                hover
                onClick={() => onAppSelect?.(row.serviceId)}
                sx={{ cursor: onAppSelect ? 'pointer' : 'default' }}
              >
                <TableCell>
                  <Typography variant="subtitle2">{row.serviceName}</Typography>
                </TableCell>
                {DORA_METRIC_CONFIGS.map((config) => {
                  const metricKey = RANKING_METRIC_KEYS[config.key];
                  const metric = row.metrics[metricKey];
                  return (
                    <TableCell key={config.key} align="right">
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          gap: 1,
                        }}
                      >
                        <Typography variant="body2">
                          {config.formatValue(metric.value)}
                        </Typography>
                        <DoraPerformanceBadge level={metric.performanceLevel} />
                      </Box>
                    </TableCell>
                  );
                })}
                <TableCell align="right">
                  <Typography variant="body2">{row.totalDeployments}</Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
}
