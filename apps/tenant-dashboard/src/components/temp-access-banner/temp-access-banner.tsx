"use client";

import { useEffect, useState, useTransition, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Button,
  Chip,
  Popover,
  Stack,
  Typography,
  Box,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { useMemberships } from "../../auth/hooks/use-memberships";
import { usePlatformAdmin } from "../../auth/hooks/use-platform-admin";
import { getTempAccessStatusAction } from "@/features/org-lifecycle/action-adapters";
import { revokeTempAccess } from "../../sections/platform-admin/temp-access/actions";
import { paths } from "../../routes/paths";
import { POPOVER } from "../../layouts/config-layout";

interface TempAccessInfo {
  grantId: string;
  organizationName: string;
  expiresAt: string;
  timeRemainingMinutes: number;
}

/**
 * Header indicator shown to platform admins when they have temporary access to a customer's org.
 * Displays as a chip in the header with a popover for details and revoke action.
 */
export function TempAccessIndicator() {
  const router = useRouter();
  const { orgName } = useParams();
  const { getMembershipByOrgName } = useMemberships();
  const { isPlatformAdmin } = usePlatformAdmin();
  const [tempAccess, setTempAccess] = useState<TempAccessInfo | null>(null);
  const [isPending, startTransition] = useTransition();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const orgNameStr = Array.isArray(orgName) ? orgName[0] : orgName;
  const membership = getMembershipByOrgName(orgNameStr ?? "");
  const tenantId = membership?.tenant_id;

  const fetchTempAccess = useCallback(async (): Promise<TempAccessInfo | null> => {
    if (!tenantId) return null;
    try {
      const result = await getTempAccessStatusAction(tenantId);
      if (result.data?.hasAccess) {
        return {
          grantId: result.data.grantId!,
          organizationName: result.data.organizationName!,
          expiresAt: result.data.expiresAt!,
          timeRemainingMinutes: result.data.timeRemainingMinutes!,
        };
      }
      return null;
    } catch {
      // Fail-closed: hide chip rather than leave a stale one when the action fails
      // (e.g. Vercel cycling connections during deploy → "Failed to fetch").
      return null;
    }
  }, [tenantId]);

  useEffect(() => {
    if (!isPlatformAdmin || !tenantId) {
      setTempAccess(null);
      return;
    }

    // Cancellation flag prevents setState after unmount when the in-flight
    // server action resolves late (or rejects during a Vercel deploy).
    let cancelled = false;

    const load = async () => {
      const next = await fetchTempAccess();
      if (!cancelled) setTempAccess(next);
    };

    load();

    const onFocus = () => {
      load();
    };
    window.addEventListener("focus", onFocus);

    const tick = setInterval(() => {
      setTempAccess((current) => {
        if (!current) return current;
        const remainingMs = new Date(current.expiresAt).getTime() - Date.now();
        const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60000));
        if (remainingMinutes <= 0) return null;
        if (remainingMinutes === current.timeRemainingMinutes) return current;
        return { ...current, timeRemainingMinutes: remainingMinutes };
      });
    }, 60000);

    return () => {
      cancelled = true;
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [isPlatformAdmin, tenantId, fetchTempAccess]);

  const handleRevoke = () => {
    if (!tempAccess) return;

    startTransition(async () => {
      const result = await revokeTempAccess({ grantId: tempAccess.grantId });
      if (!result.error) {
        setTempAccess(null);
        setAnchorEl(null);
        router.push(paths.platformAdmin.organizations);
      }
    });
  };

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  if (!tempAccess) return null;

  const formatTimeRemaining = (minutes: number): string => {
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours}h`;
    }
    return `${hours}h ${remainingMinutes}m`;
  };

  const open = Boolean(anchorEl);

  return (
    <>
      <Chip
        icon={<Iconify icon="mdi:shield-key-outline" width={14} />}
        label={`Temp access · ${formatTimeRemaining(tempAccess.timeRemainingMinutes)}`}
        size="small"
        onClick={handleClick}
        sx={(theme) => ({
          cursor: "pointer",
          height: 24,
          borderRadius: "6px",
          bgcolor: (theme.vars ?? theme).palette.warning.lighter,
          color: (theme.vars ?? theme).palette.warning.darker,
          border: "1px solid",
          borderColor: (theme.vars ?? theme).palette.warning.light,
          fontFamily: theme.typography.fontFamilyMonospace,
          fontSize: 12,
          fontWeight: 600,
          "&:hover": {
            bgcolor: (theme.vars ?? theme).palette.warning.lighter,
            borderColor: (theme.vars ?? theme).palette.warning.main,
          },
          "& .MuiChip-icon": { color: "inherit" },
          "& .MuiChip-label": { px: 1 },
        })}
      />
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "center",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "center",
        }}
        slotProps={{
          paper: {
            sx: { p: 2, width: POPOVER.TEMP_ACCESS_WIDTH },
          },
        }}
      >
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="subtitle2" sx={{ color: "text.primary" }}>
              Temporary Access Active
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              You are viewing <strong>{tempAccess.organizationName}</strong> as
              a platform admin with read-only access.
            </Typography>
          </Box>
          <Box
            sx={(theme) => ({
              px: 1,
              py: 0.5,
              borderRadius: "6px",
              bgcolor: (theme.vars ?? theme).palette.warning.lighter,
            })}
          >
            <Typography
              variant="caption"
              sx={(theme) => ({
                fontFamily: theme.typography.fontFamilyMonospace,
                color: (theme.vars ?? theme).palette.warning.darker,
              })}
            >
              Expires in {formatTimeRemaining(tempAccess.timeRemainingMinutes)}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            color="warning"
            size="small"
            onClick={handleRevoke}
            disabled={isPending}
            startIcon={<Iconify icon="mdi:exit-to-app" width={18} />}
            fullWidth
          >
            {isPending ? "Revoking..." : "Exit customer org"}
          </Button>
        </Stack>
      </Popover>
    </>
  );
}

