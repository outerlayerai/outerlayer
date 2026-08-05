import { Box, Grid, Skeleton, Stack } from "@mui/material";
import { visuallyHidden } from "@mui/utils";

/**
 * The dashboard detail is entirely server-loaded — the client hook only
 * presents what the React Server Component (RSC) seeds — so without this boundary the content frame
 * stays blank for the whole read. The blocks mirror the destination layout:
 * title + filter row, then the widget grid.
 *
 * Deliberately bespoke rather than the shared `PageSkeleton`: widgets default
 * to half the 12-column grid and four rows tall, so the destination is a 2-up
 * grid of ~320px blocks under a header carrying three controls. The shared
 * `card-grid` variant is 3-up at 160px with a single header action, and a
 * placeholder shaped unlike its destination reflows the page on exactly the
 * axes it exists to hold still. Keep the shape; do not swap it for the
 * primitive.
 *
 * `role="status"` with real text inside it, because Skeletons contribute no
 * accessible name and a live region announces its content, not a label.
 * `aria-busy` stays off: on a live region it defers the announcement until it
 * clears, and this region never clears — it unmounts once the data lands.
 */
export default function DashboardDetailLoading() {
  return (
    <Stack spacing={3} role="status" data-testid="dashboard-detail-loading">
      <Box component="span" sx={visuallyHidden}>
        Loading
      </Box>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Box>
          <Skeleton variant="text" width={220} height={40} />
          <Skeleton variant="text" width={320} height={20} />
        </Box>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Skeleton variant="rounded" width={110} height={30} />
          <Skeleton variant="rounded" width={130} height={30} />
          <Skeleton variant="rounded" width={130} height={36} />
        </Stack>
      </Stack>
      <Grid container spacing={2}>
        {[0, 1, 2, 3].map((i) => (
          <Grid size={{ xs: 12, md: 6 }} key={i}>
            <Skeleton variant="rounded" height={320} sx={{ borderRadius: 2 }} />
          </Grid>
        ))}
      </Grid>
    </Stack>
  );
}
