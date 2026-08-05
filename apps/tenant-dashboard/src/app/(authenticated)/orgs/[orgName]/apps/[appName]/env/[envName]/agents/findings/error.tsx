"use client";

import { Card, Stack, Typography } from "@mui/material";
import { ErrorState } from "@/components/error-state";
import { useErrorBoundaryRecovery } from "@/hooks/use-error-boundary-recovery";

/**
 * Findings read failures land here instead of unwinding to the root boundary,
 * which replaces the whole app shell with a crash screen. The detector
 * snapshot comes from the analytics store, where an unavailable backend is a
 * transient the user can retry — `reset()` re-runs the segment's server
 * render without a full reload.
 *
 * Catching first also means catching a deploy landing mid-navigation, which is
 * not a findings failure at all, so the shared recovery decides that before the
 * card gets a chance to blame the analytics store.
 */
export default function AgentFindingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { isReloading } = useErrorBoundaryRecovery(error, "agent-findings-error-boundary");

  if (isReloading) {
    // Deliberately not `ErrorState`: a reload already in flight is not a fault
    // to announce, and offering a retry button here would race it.
    return (
      <Card sx={{ p: 6 }} data-testid="agent-findings-updating">
        <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
          <Typography variant="h6">Updating application...</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 480 }}>
            Loading the latest version. This will only take a moment.
          </Typography>
        </Stack>
      </Card>
    );
  }

  // The reason is a fixed sentence rather than `error.message`: whatever
  // unwound to a route boundary can be a framework internal, and a raw digest
  // or chunk path tells the reader less than nothing.
  return (
    <ErrorState
      title="Couldn't load findings"
      description="The findings data couldn't be read just now. Nothing was lost — try again."
      onRetry={reset}
    />
  );
}
