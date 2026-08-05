"use client";

import { Box, Button, Card, Stack, Typography } from "@mui/material";
import Iconify from "@/components/iconify";
import { useErrorBoundaryRecovery } from "@/hooks/use-error-boundary-recovery";

/**
 * Sessions read failures land here instead of unwinding to the root boundary,
 * which replaces the whole app shell with a crash screen. The session list and
 * a session's detail both read from the analytics store, where an unavailable
 * backend is a transient the user can retry — `reset()` re-runs the
 * segment's server render without a full reload.
 *
 * Catching first also means catching a deploy landing mid-navigation, which is
 * not a sessions failure at all, so the shared recovery decides that before the
 * card gets a chance to blame the analytics store.
 */
export default function AgentSessionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { isReloading, needsManualRefresh, manualRefreshReason } = useErrorBoundaryRecovery(
    error,
    "agent-sessions-error-boundary",
  );

  if (isReloading) {
    return (
      <Card sx={{ p: 6 }} data-testid="agent-sessions-updating">
        <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
          <Typography variant="h6">Updating application...</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480 }}>
            Loading the latest version. This will only take a moment.
          </Typography>
        </Stack>
      </Card>
    );
  }

  // The automatic recovery refused. `reset()` re-runs the segment against the
  // same bundle, so blaming the analytics store and offering a retry would be
  // wrong twice over. Neither wording states a release as fact — an aborted React Server Component (RSC)
  // stream reaches both paths with no deploy involved.
  if (needsManualRefresh) {
    return (
      <Card sx={{ p: 6 }} data-testid="agent-sessions-stale-bundle">
        <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
          <Typography variant="h6">
            {manualRefreshReason === "reloads-spent"
              ? "This page still is not loading"
              : "This page may be out of date"}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480 }}>
            {manualRefreshReason === "reloads-spent"
              ? "Reloading did not fix it. Refresh to try again."
              : "Refresh to load the current version."}
          </Typography>
          <Box>
            <Button
              size="small"
              onClick={() => window.location.reload()}
              startIcon={<Iconify icon="eva:refresh-fill" />}
            >
              Refresh page
            </Button>
          </Box>
        </Stack>
      </Card>
    );
  }

  return (
    <Card sx={{ p: 6 }} data-testid="agent-sessions-error">
      <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
        <Typography variant="h6">Couldn&apos;t load sessions</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480 }}>
          The session data couldn&apos;t be read just now. Nothing was lost — try again.
        </Typography>
        <Box>
          <Button size="small" onClick={reset} startIcon={<Iconify icon="eva:refresh-fill" />}>
            Retry now
          </Button>
        </Box>
      </Stack>
    </Card>
  );
}
