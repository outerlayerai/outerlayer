'use client';

// ---------------------------------------------------------------------------
// DoraCollectionHealthBanner Component
//
// Surfaces collection pipeline failures and staleness at the top of the
// DORA dashboard. Renders nothing while loading or when every source is
// healthy. The whole point of this banner is that a dead pipeline must be
// impossible to mistake for "no deployments happened".
// ---------------------------------------------------------------------------

import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';

import { useDoraCollectionStatus } from '@/hooks/dora-metrics/use-dora-collection-status';
import { assessCollectionHealth } from '@/lib/dora-metrics/collection-health';

export function DoraCollectionHealthBanner() {
  const { sources, isLoading, error } = useDoraCollectionStatus();

  // The status endpoint failing is itself a (quiet) signal — but don't
  // stack a second error on top of the page's own error handling.
  if (isLoading || error) return null;

  const issues = assessCollectionHealth(sources);
  if (issues.length === 0) return null;

  return (
    <Stack spacing={1} sx={{ mb: 3 }}>
      {issues.map((issue) => (
        <Alert key={issue.source} severity={issue.level}>
          {issue.message}
        </Alert>
      ))}
    </Stack>
  );
}
