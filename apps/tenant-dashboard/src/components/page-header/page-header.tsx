"use client";

import { Box, Stack, Typography } from "@mui/material";

// ----------------------------------------------------------------------

type Props = {
  /** Page title. Always renders as `h4` — the one page-title level. */
  title: React.ReactNode;
  /**
   * One-line secondary caption under the title: repo/slug, a short
   * description, or data-freshness metadata ("computed 12 min ago"). Freshness
   * belongs here rather than in a page footer, where it reads as a stray note.
   *
   * Inline content only. It reads as one line of prose at `body2`, so a chip
   * or two beside the words is in register and a stacked block is not — that
   * belongs in `meta`.
   */
  caption?: React.ReactNode;
  /**
   * Identity metadata for a detail page — the chip/attribute row naming what
   * the entity IS (state, owner, version). Renders as its own block below the
   * caption, so it may stack and wrap where `caption` may not.
   */
  meta?: React.ReactNode;
  /**
   * Page-level actions. Right-aligned in the title row, laid out in a row with
   * `spacing={1}` between them — a page supplying its own spacing around these
   * nodes gets that gap on top.
   */
  actions?: React.ReactNode;
  /**
   * Rendered to the left of the title — a layout affordance that belongs to the
   * page rather than to its content (e.g. the tree toggle on narrow screens).
   */
  leading?: React.ReactNode;
  /** Override when one page carries more than one header. */
  "data-testid"?: string;
};

/**
 * The page header: `h4` title, an optional one-line caption beneath it, an
 * optional metadata block under that, and actions pushed to the trailing edge
 * of the title row. Breadcrumbs are a separate concern
 * (`components/custom-breadcrumbs`) and are not part of this anatomy.
 */
export function PageHeader({
  title,
  caption,
  meta,
  actions,
  leading,
  "data-testid": dataTestId = "page-header",
}: Props) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      data-testid={dataTestId}
      sx={{
        alignItems: "flex-start",
        justifyContent: "space-between",
        // A long title next to two or more actions has to break onto its own
        // row rather than squeeze both. Gap spacing (not margins) is what
        // survives that wrap without collapsing the space between rows.
        flexWrap: "wrap",
        // A full-height page (a fixed-height, non-scrolling editor shell) makes
        // this header a flex item competing with a body that wants every
        // remaining pixel. At the flex default it would compress instead, so the
        // header has to opt out of shrinking. On a normally-scrolling page there
        // is nothing to shrink against and this changes nothing.
        flexShrink: 0,
        mb: 3,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", minWidth: 0 }}>
        {leading}
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4">{title}</Typography>
          {caption && (
            // A `div` because the prop takes any node: a chip or a Box-based
            // shim inside a `p` is invalid nesting and a hydration error in a
            // real browser, and nothing in the type system or the test
            // environment catches it.
            <Typography
              variant="body2"
              component="div"
              data-testid={`${dataTestId}-caption`}
              sx={{ color: "text.secondary", mt: 0.5 }}
            >
              {caption}
            </Typography>
          )}
          {meta && (
            <Box data-testid={`${dataTestId}-meta`} sx={{ mt: 1 }}>
              {meta}
            </Box>
          )}
        </Box>
      </Stack>
      {actions && (
        <Stack
          direction="row"
          spacing={1}
          data-testid={`${dataTestId}-actions`}
          sx={{ alignItems: "center", flexShrink: 0 }}
        >
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
