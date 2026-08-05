'use client';

// ---------------------------------------------------------------------------
// DoraEmptyState Component
//
// Shown when no deployment data is available for the selected time range.
// ---------------------------------------------------------------------------

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import Iconify from '@/components/iconify';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type LoadHistoricalStatus = 'idle' | 'loading' | 'done' | 'error';

interface DoraEmptyStateProps {
  isPolling?: boolean;
  onLoadHistorical?: () => void;
  loadHistoricalStatus?: LoadHistoricalStatus;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DoraEmptyState({
  isPolling = false,
  onLoadHistorical,
  loadHistoricalStatus = 'idle',
}: DoraEmptyStateProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        py: 10,
        px: 3,
      }}
    >
      <Iconify
        icon="mdi:chart-timeline-variant-shimmer"
        sx={{ width: 64, height: 64, color: 'text.disabled', mb: 2 }}
      />
      <Typography variant="h6" gutterBottom sx={{
        color: "text.secondary"
      }}>
        No Data Yet
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.disabled",
          maxWidth: 400
        }}>
        Deployments are recorded by CI as they happen, and incidents are collected every
        30 minutes. Data appears here after the next deploy.
      </Typography>
      {isPolling && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            mt: 3,
            color: 'text.disabled'
          }}>
          <CircularProgress size={16} color="inherit" />
          <Typography variant="caption">Checking for data...</Typography>
        </Stack>
      )}
      {onLoadHistorical && loadHistoricalStatus !== 'done' && (
        <Box sx={{ mt: 3 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={onLoadHistorical}
            disabled={loadHistoricalStatus === 'loading'}
            startIcon={
              loadHistoricalStatus === 'loading' ? (
                <CircularProgress size={14} color="inherit" />
              ) : undefined
            }
          >
            {loadHistoricalStatus === 'loading' ? 'Loading...' : 'Load Historical Data'}
          </Button>

          {loadHistoricalStatus === 'error' && (
            <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
              Backfill failed. Please try again.
            </Typography>
          )}
        </Box>
      )}
      {loadHistoricalStatus === 'done' && (
        <Typography
          variant="caption"
          sx={{
            color: "text.disabled",
            mt: 3
          }}>
          Historical data loaded. Waiting for metrics to populate...
        </Typography>
      )}
    </Box>
  );
}
