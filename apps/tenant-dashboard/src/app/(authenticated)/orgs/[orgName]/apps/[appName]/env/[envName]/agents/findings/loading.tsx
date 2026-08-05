import { Box, Skeleton, Stack } from "@mui/material";
import { visuallyHidden } from "@mui/utils";

/**
 * Findings loads on the server, so this stands in for the whole segment while
 * the detector snapshot is read. It mirrors the destination — a header pair
 * over a column of full-width outlined cards — because a placeholder shaped
 * differently from what follows reflows the page it exists to hold still.
 *
 * The shape is hand-rolled rather than taken from `PageSkeleton`: none of that
 * component's variants is a vertical list of full-width cards, and a table or
 * card-grid placeholder would promise furniture this page does not have.
 */

/** Matches `Stack spacing={1.25}` between finding cards. */
const CARD_GAP = 1.25;
const CARDS = 5;
/**
 * A finding card at its common size: severity/cost/detector row, a one-line
 * summary, and a row of session chips. Cards grow past this when a finding
 * carries a suggestion or wraps, so the reserve is a typical height, not a
 * ceiling.
 */
const CARD_HEIGHT = 104;

export default function AgentFindingsLoading() {
  return (
    <Box
      data-testid="findings-skeleton"
      // The live region announces its own CONTENT, so the loading text has to
      // be real text inside it — an aria-label on `status` is not announced.
      role="status"
    >
      <Box component="span" sx={visuallyHidden}>
        Loading
      </Box>
      {/* The page header renders inside the suspended segment, so the
          placeholder brings its own — otherwise the title pops in after the
          body. No action button is reserved: this page has none. */}
      <Box data-testid="findings-skeleton-header" sx={{ mb: 3 }}>
        <Skeleton variant="text" width={220} sx={{ fontSize: "2rem" }} />
        <Skeleton variant="text" width={420} sx={{ fontSize: "0.875rem" }} />
      </Box>
      <Stack spacing={CARD_GAP}>
        {Array.from({ length: CARDS }, (_v, i) => (
          <Skeleton
            key={i}
            variant="rounded"
            height={CARD_HEIGHT}
            data-testid="findings-skeleton-card"
            sx={{ borderRadius: 2 }}
          />
        ))}
      </Stack>
    </Box>
  );
}
