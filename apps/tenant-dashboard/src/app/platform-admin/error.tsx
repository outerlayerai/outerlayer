'use client';

import { Container, Card, CardContent, Typography, Button, Stack } from '@mui/material';
import { useErrorBoundaryRecovery } from '@/hooks/use-error-boundary-recovery';
import Iconify from '@/components/iconify';

export default function PlatformAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A deploy landing mid-navigation is not a platform-admin fault: the shared
  // recovery reloads it away instead of showing a crash card and reporting it.
  const { isReloading, needsManualRefresh, manualRefreshReason } = useErrorBoundaryRecovery(
    error,
    'platform-admin-error-boundary',
  );

  if (isReloading) {
    return (
      <Container maxWidth="md" sx={{ py: 8 }}>
        <Card>
          <CardContent>
            <Stack
              spacing={2}
              sx={{
                alignItems: "center",
                textAlign: "center"
              }}>
              <Typography variant="h5" component="h1">Updating application...</Typography>
              <Typography variant="body1" sx={{
                color: "text.secondary"
              }}>
                Loading the latest version. This will only take a moment.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 8 }}>
      <Card>
        <CardContent>
          <Stack
            spacing={3}
            sx={{
              alignItems: "center",
              textAlign: "center"
            }}>
            <Iconify
              icon="mdi:alert-circle"
              width={64}
              sx={{ color: 'error.main' }}
            />
{/* The automatic recovery can refuse for two different reasons, and neither
            may state a release as fact — an aborted RSC stream reaches both paths
            with no deploy involved. `reset()` is wrong for both: it re-renders
            against the same bundle, so on the spent-budget path it retries what
            two reloads just failed to fix, and each press throws a new Error that
            slips past the report dedupe. */}
            <Typography variant="h4">
              {manualRefreshReason === 'reloads-spent'
                ? 'This page still is not loading'
                : manualRefreshReason === 'guard-unverifiable'
                  ? 'This page may be out of date'
                  : 'Something went wrong'}
            </Typography>
            <Typography variant="body1" sx={{
              color: "text.secondary"
            }}>
              {manualRefreshReason === 'reloads-spent'
                ? 'Reloading did not fix it. Refresh to try again.'
                : manualRefreshReason === 'guard-unverifiable'
                  ? 'Refresh to load the current version.'
                  : 'An error occurred while loading this page. Please try again or contact support if the problem persists.'}
            </Typography>
            {error.digest && (
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>
                Error ID: {error.digest}
              </Typography>
            )}
            <Stack direction="row" spacing={2}>
              <Button
                variant="contained"
                onClick={needsManualRefresh ? () => window.location.reload() : reset}
                startIcon={<Iconify icon="mdi:refresh" />}
              >
                {needsManualRefresh ? 'Refresh page' : 'Try again'}
              </Button>
              <Button
                variant="outlined"
                href="/platform-admin"
                startIcon={<Iconify icon="mdi:home" />}
              >
                Back to Dashboard
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
