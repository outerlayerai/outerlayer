"use client";

import { useState, useTransition } from "react";
import {
  Box,
  Button,
  Card,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";

import { useSnackbar } from "@/components/snackbar";

import { approveDeviceAuthAction, denyDeviceAuthAction } from "../actions";
import type { PendingDeviceAuthRequest } from "../types";

interface DeviceLoginApprovalApp {
  id: string;
  name: string;
}

interface DeviceLoginApprovalProps {
  request: PendingDeviceAuthRequest;
  apps: DeviceLoginApprovalApp[];
}

/**
 * The device-code confirmation card: shows the code the user typed in,
 * lets them pick which app the CLI's key will be scoped to, and
 * approves/denies. Once resolved (either action, or an "already resolved"
 * response — e.g. two tabs racing the same code) the card swaps to a
 * terminal message rather than staying interactive.
 */
export function DeviceLoginApproval({ request, apps }: DeviceLoginApprovalProps) {
  const { enqueueSnackbar } = useSnackbar();
  const [appId, setAppId] = useState(apps[0]?.id ?? "");
  const [resolved, setResolved] = useState<"approved" | "denied" | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleApprove = () => {
    if (!appId) return;
    startTransition(async () => {
      const result = await approveDeviceAuthAction({ requestId: request.requestId, appId });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        enqueueSnackbar(result.data.message, { variant: "error" });
        return;
      }
      setResolved("approved");
    });
  };

  const handleDeny = () => {
    startTransition(async () => {
      const result = await denyDeviceAuthAction({ requestId: request.requestId });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        enqueueSnackbar(result.data.message, { variant: "error" });
        return;
      }
      setResolved("denied");
    });
  };

  if (resolved === "approved") {
    return (
      <Card sx={{ p: 4, maxWidth: 480 }}>
        <Typography variant="h6">Device approved</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          You can close this tab and return to your terminal.
        </Typography>
      </Card>
    );
  }
  if (resolved === "denied") {
    return (
      <Card sx={{ p: 4, maxWidth: 480 }}>
        <Typography variant="h6">Device login denied</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          You can close this tab.
        </Typography>
      </Card>
    );
  }

  return (
    <Card sx={{ p: 4, maxWidth: 480 }}>
      <Stack spacing={3}>
        <Stack spacing={0.5}>
          <Typography variant="h6">Confirm device login</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Code <Box component="span" sx={{ fontWeight: 600 }}>{request.userCode}</Box> is
            requesting access to capture sessions on your behalf.
          </Typography>
        </Stack>

        <FormControl fullWidth size="small">
          <InputLabel id="device-login-app-label">App</InputLabel>
          <Select
            labelId="device-login-app-label"
            label="App"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          >
            {apps.map((app) => (
              <MenuItem key={app.id} value={app.id}>
                {app.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Stack direction="row" spacing={2}>
          <Button
            fullWidth
            variant="contained"
            disabled={!appId || isPending}
            loading={isPending}
            onClick={handleApprove}
          >
            Approve
          </Button>
          <Button fullWidth variant="outlined" disabled={isPending} onClick={handleDeny}>
            Deny
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
