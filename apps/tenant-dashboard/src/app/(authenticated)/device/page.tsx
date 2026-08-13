"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Skeleton, Stack, Typography } from "@mui/material";

import { AppLayout } from "../../../layouts/app/app-layout";
import { useAuthContext } from "../../../auth/hooks";
import type { SupabaseContextType } from "../../../auth/types";
import { useMemberships } from "../../../auth/hooks/use-memberships";
import { paths } from "../../../routes/paths";

/**
 * Org-less entry point — what the CLI's `verification_url` opens. Resolves
 * the caller's org exactly like `resolveCliTenant`'s precedence (here:
 * their sole active membership) and hands off to the org-scoped page,
 * carrying the user_code query param along. A caller with zero or multiple
 * orgs falls back to the org picker; they re-open the link (or re-enter the
 * code manually) once inside the org they want — the picker itself has no
 * way to carry an arbitrary query param through org selection today.
 */
export default function DeviceAuthEntryPage() {
  const router = useRouter();
  const { loading } = useAuthContext() as SupabaseContextType;
  const { memberships } = useMemberships();
  const searchParams = useSearchParams();
  const userCode = searchParams.get("user_code");

  useEffect(() => {
    if (loading) return;
    const query = userCode ? `?user_code=${encodeURIComponent(userCode)}` : "";
    if (memberships.length === 1) {
      const orgName = memberships[0]?.tenant?.organization_name;
      if (orgName) {
        router.replace(`${paths.orgs.org.device.root(orgName)}${query}`);
        return;
      }
    }
    router.replace(`${paths.orgs.root}?picker=1`);
  }, [loading, memberships, router, userCode]);

  return (
    <AppLayout>
      <Box sx={{ height: "100%", display: "flex", justifyContent: "center", p: 3, pt: { xs: 4, md: 8 } }}>
        <Stack spacing={2} sx={{ maxWidth: 480, width: "100%" }}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Taking you to the right organization…
          </Typography>
          <Skeleton variant="rounded" height={80} />
        </Stack>
      </Box>
    </AppLayout>
  );
}
