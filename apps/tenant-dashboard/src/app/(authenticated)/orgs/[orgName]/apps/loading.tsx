import { Stack, Skeleton, Grid, Typography } from "@mui/material";
import { AppLayout } from "../../../../../layouts/app/app-layout";

export default function AppsLoading() {
  return (
    <AppLayout>
      <Stack spacing={3}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between"
          }}>
          <Typography variant="h5">Apps</Typography>
          <Skeleton variant="rounded" width={120} height={36} />
        </Stack>
        <Grid container spacing={2}>
          {[1, 2, 3].map((i) => (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={i}>
              <Skeleton
                variant="rounded"
                height={160}
                sx={{ borderRadius: 2 }}
              />
            </Grid>
          ))}
        </Grid>
      </Stack>
    </AppLayout>
  );
}
