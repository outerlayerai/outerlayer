import { Box, Typography } from "@mui/material";

import { AppLayout } from "../../../../../layouts/app/app-layout";
import { loadAppsList } from "@/features/apps/read";
import { loadPendingDeviceAuthRequest } from "@/features/device-auth/read";
import { DeviceLoginApproval } from "@/features/device-auth/components/device-login-approval";

export const metadata = {
  title: "Confirm device login",
};

// Tenant-scoped and auth-gated, and the state it reads (device_auth_request)
// changes on every approval — force-dynamic rather than any cached path.
export const dynamic = "force-dynamic";

export default async function DeviceAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const { user_code: userCode } = await searchParams;
  const [request, apps] = await Promise.all([
    userCode ? loadPendingDeviceAuthRequest(userCode) : Promise.resolve(null),
    loadAppsList(),
  ]);

  return (
    <AppLayout>
      <Box sx={{ height: "100%", display: "flex", justifyContent: "center", p: 3, pt: { xs: 4, md: 8 } }}>
        {request ? (
          <DeviceLoginApproval request={request} apps={apps.map((app) => ({ id: app.id, name: app.name }))} />
        ) : (
          <Box sx={{ maxWidth: 480, textAlign: "center" }}>
            <Typography variant="h6">This code is no longer valid</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              It may have expired, already been used, or been typed incorrectly. Run{" "}
              <Box component="code">outerlayer login</Box> again to get a fresh one.
            </Typography>
          </Box>
        )}
      </Box>
    </AppLayout>
  );
}
