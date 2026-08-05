"use client";

import { Box, Button, Container, Typography } from "@mui/material";
import { useErrorBoundaryRecovery } from "@/hooks/use-error-boundary-recovery";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { isReloading, needsManualRefresh, manualRefreshReason } = useErrorBoundaryRecovery(
    error,
    "route-error-boundary",
  );

  // Show "Updating..." UI while reloading for skew errors
  if (isReloading) {
    return (
      <Container maxWidth="sm">
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "50vh",
            textAlign: "center",
            gap: 2,
          }}
        >
          <Typography variant="h5" component="h1">
            Updating application...
          </Typography>
          <Typography variant="body1" sx={{
            color: "text.secondary"
          }}>
            Loading the latest version. This will only take a moment.
          </Typography>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "50vh",
          textAlign: "center",
          gap: 2,
        }}
      >
{/* The automatic recovery can refuse for two different reasons, and neither
            may state a release as fact — an aborted RSC stream reaches both paths
            with no deploy involved. `reset()` is wrong for both: it re-renders
            against the same bundle, so on the spent-budget path it retries what
            two reloads just failed to fix, and each press throws a new Error that
            slips past the report dedupe. */}
        <Typography variant="h4" component="h1">
          {manualRefreshReason === "reloads-spent"
            ? "This page still is not loading"
            : manualRefreshReason === "guard-unverifiable"
              ? "This page may be out of date"
              : "Something went wrong"}
        </Typography>
        <Typography variant="body1" sx={{
          color: "text.secondary"
        }}>
          {manualRefreshReason === "reloads-spent"
            ? "Reloading did not fix it. Refresh to try again."
            : manualRefreshReason === "guard-unverifiable"
              ? "Refresh to load the current version."
              : "An unexpected error occurred. Please try again."}
        </Typography>
        <Button
          variant="contained"
          onClick={needsManualRefresh ? () => window.location.reload() : reset}
        >
          {needsManualRefresh ? "Refresh page" : "Try again"}
        </Button>
      </Box>
    </Container>
  );
}
