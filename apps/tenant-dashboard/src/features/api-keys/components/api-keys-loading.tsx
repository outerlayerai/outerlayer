"use client";

import {
  Grid,
  Card,
  CardContent,
  Skeleton,
  Box,
  Stack,
  List,
  ListItem,
} from "@mui/material";
import { useResponsive } from "@/hooks/use-responsive";

export function ApiKeysLoading() {
  const mdUp = useResponsive("up", "md");

  return (
    <Grid container>
      {mdUp && (
        <Grid size={{ md: 4 }}>
          <Box sx={{ pr: 3 }}>
            <Skeleton variant="text" width="50%" height={32} sx={{ mb: 0.5 }} />
            <Skeleton variant="text" width="80%" height={20} />
            <Skeleton variant="text" width="70%" height={20} />
          </Box>
        </Grid>
      )}
      <Grid size={{ xs: 12, md: 8 }}>
        <Card>
          {!mdUp && (
            <Box sx={{ p: 3, pb: 0 }}>
              <Skeleton variant="text" width="35%" height={32} />
            </Box>
          )}

          <CardContent>
            <Stack spacing={3}>
              <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                <Skeleton variant="rounded" width={120} height={36} />
              </Box>

              <Card>
                <List>
                  <ListItem divider sx={{ p: 2, gap: 2 }}>
                    <Skeleton variant="text" width={100} height={20} />
                    <Skeleton variant="text" width={120} height={20} />
                    <Skeleton variant="text" width={120} height={20} />
                    <Box sx={{
                      width: 36
                    }} />
                  </ListItem>

                  {[1, 2, 3].map((index) => (
                    <ListItem
                      key={index}
                      divider={index !== 3}
                      sx={{ p: 2, gap: 2 }}
                    >
                      <Skeleton variant="text" width={150} height={20} />
                      <Skeleton variant="text" width={100} height={20} />
                      <Skeleton variant="text" width={120} height={20} />
                      <Skeleton variant="circular" width={32} height={32} />
                    </ListItem>
                  ))}
                </List>
              </Card>
            </Stack>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}
