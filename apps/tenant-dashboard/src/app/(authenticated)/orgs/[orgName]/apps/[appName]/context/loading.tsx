import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";

import { PageSkeleton } from "@/components/page-skeleton";

/**
 * Suspense fallback for this segment. Without it the nearest boundary is the
 * `[appName]` one, whose fallback is a full-page spinner — and this route
 * server-renders its whole tree before first paint, so that spinner is what a
 * visitor actually sees.
 *
 * The shell math is repeated rather than shared with the client view: it is two
 * declarations, and a module existing only to hold them would be indirection
 * for its own sake. The height is the app header plus the content frame's top
 * and bottom gutters — the page itself never scrolls.
 */
const PAGE_CHROME_HEIGHT = 144;

export default function ContextLoading() {
  return (
    <Box
      sx={{
        height: `calc(100dvh - ${PAGE_CHROME_HEIGHT}px)`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Mirrors PageHeader's own block: h4-sized title, caption, trailing
          actions. Reserved here rather than by the skeleton's `header` so the
          resync button and view toggle keep their place on the trailing edge. */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0, mb: 3 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Skeleton variant="text" width={140} sx={{ fontSize: "2rem" }} />
          <Skeleton variant="text" width={220} sx={{ fontSize: "0.875rem" }} />
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
          <Skeleton variant="circular" width={30} height={30} />
          <Skeleton variant="rounded" width={144} height={30} />
        </Stack>
      </Stack>
      <PageSkeleton variant="two-pane" header={false} />
    </Box>
  );
}
