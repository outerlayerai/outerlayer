"use client";

import { Button, Card, Stack, Typography } from "@mui/material";

import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

type Props = {
  /** Short heading naming what failed to load. Renders as `h6`. */
  title: React.ReactNode;
  /**
   * What went wrong, in the user's terms — usually the caught error's message.
   * A failure with no explanation leaves retrying as the only thing to try.
   */
  description?: React.ReactNode;
  /**
   * Runs the load again: `router.refresh()` on a server-fetched surface,
   * SWR's `mutate()` on a client-fetched one. Required, because an error the
   * user cannot retry from is a dead end.
   */
  onRetry: () => void;
  /** Override when "Retry now" does not name what the retry actually does. */
  retryLabel?: string;
  /** Override when one page carries more than one error state. */
  "data-testid"?: string;
};

/** Cap the explanation so it wraps into a readable column, not a full-width line. */
const DESCRIPTION_MAX_WIDTH = 480;

/**
 * The load-failure card: `h6` heading, the reason beneath it, and a retry
 * button. Sibling to `EmptyState` rather than a variant of it — the two carry
 * the same card treatment but say opposite things, and a surface that renders
 * "nothing here yet" for a failed fetch has told the user their data is gone.
 *
 * `role="alert"` so a failure is never left to be discovered by reading. What
 * that buys depends on when the card mounts: appearing after load — a failed
 * refetch or a retry that failed again — it is announced, while a card already
 * present at first paint is not, because a live region only announces content
 * that arrives after it exists. In both cases the role is what marks this as a
 * fault rather than an empty result, which is the distinction a screen reader
 * otherwise cannot draw between two identical-looking cards.
 *
 * This is for a load that failed. A failed mutation is a toast, and a missing
 * record is a not-found page.
 */
export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = "Retry now",
  "data-testid": dataTestId = "error-state",
}: Props) {
  return (
    <Card data-testid={dataTestId} role="alert" sx={{ p: 6 }}>
      <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
        <Typography variant="h6">{title}</Typography>
        {description && (
          <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: DESCRIPTION_MAX_WIDTH }}>
            {description}
          </Typography>
        )}
        {/* The click event is swallowed rather than forwarded: `onRetry` is
            declared zero-argument, so a caller may pass a function whose first
            parameter means something else entirely. */}
        <Button
          size="small"
          data-testid={`${dataTestId}-retry`}
          onClick={() => onRetry()}
          startIcon={<Iconify icon="eva:refresh-fill" />}
        >
          {retryLabel}
        </Button>
      </Stack>
    </Card>
  );
}
