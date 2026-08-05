"use client";

import { Box, Card, Stack, Typography } from "@mui/material";

// ----------------------------------------------------------------------

type Props = {
  /** Short heading naming the absence. Renders as `h6`. */
  title: React.ReactNode;
  /** One or two sentences explaining why the surface is empty. */
  description?: React.ReactNode;
  /**
   * Secondary metadata about the absence rather than a way out of it — a
   * progress readout ("40 of 100 summaries collected"), a threshold, a count.
   * Renders between the description and the action so the CTA slot stays a CTA.
   */
  meta?: React.ReactNode;
  /** Optional call to action. */
  action?: React.ReactNode;
  /** Optional decorative node above the heading. */
  icon?: React.ReactNode;
  /**
   * `card` — the general empty state, a centered block inside a Card.
   * `dashed` — a dashed-outline block, reserved for create-your-first-X
   * prompts, where the outline reads as a slot waiting to be filled.
   */
  variant?: "card" | "dashed";
  /** Override when one page carries more than one empty state. */
  "data-testid"?: string;
};

/** Cap the explanation so it wraps into a readable column, not a full-width line. */
const DESCRIPTION_MAX_WIDTH = 480;

/**
 * The empty state: `h6` heading, an optional `body2` explanation, and an
 * optional action, centered. Empty is not error and not not-found — this
 * renders only when a surface legitimately has nothing to show. A load
 * failure is `ErrorState` (`@/components/error-state`), a separate component
 * on purpose: one card that covered both would let a transient failure render
 * as an empty account.
 */
export function EmptyState({
  title,
  description,
  meta,
  action,
  icon,
  variant = "card",
  "data-testid": dataTestId = "empty-state",
}: Props) {
  const body = (
    <Stack spacing={1.5} sx={{ alignItems: "center", textAlign: "center" }}>
      {icon}
      <Typography variant="h6">{title}</Typography>
      {description && (
        <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: DESCRIPTION_MAX_WIDTH }}>
          {description}
        </Typography>
      )}
      {meta && <Box data-testid={`${dataTestId}-meta`}>{meta}</Box>}
      {action}
    </Stack>
  );

  if (variant === "dashed") {
    return (
      <Box
        data-testid={dataTestId}
        data-variant="dashed"
        sx={{
          py: 6,
          px: 3,
          border: "1px dashed",
          borderColor: "divider",
          borderRadius: 2,
        }}
      >
        {body}
      </Box>
    );
  }

  return (
    <Card data-testid={dataTestId} data-variant="card" sx={{ p: 6 }}>
      {body}
    </Card>
  );
}
