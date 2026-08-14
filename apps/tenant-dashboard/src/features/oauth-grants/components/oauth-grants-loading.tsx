"use client";

import { Box, Card, List, ListItem, Skeleton, Stack } from "@mui/material";

export function OAuthGrantsLoading() {
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Skeleton variant="text" width="60%" height={20} />
      <Card>
        <List>
          {[1, 2].map((index) => (
            <ListItem key={index} divider={index !== 2} sx={{ p: 2, gap: 2 }}>
              <Box sx={{ width: 40, height: 40, borderRadius: 1 }}>
                <Skeleton variant="rounded" width={40} height={40} />
              </Box>
              <Skeleton variant="text" width={150} height={20} />
              <Skeleton variant="text" width={120} height={20} />
              <Skeleton variant="circular" width={32} height={32} />
            </ListItem>
          ))}
        </List>
      </Card>
    </Stack>
  );
}
