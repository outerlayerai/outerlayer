"use client";

import { useEffect, useState } from "react";
import { Alert, Box } from "@mui/material";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";

import type { LicenseStatus } from "../types";

// Admin-wide banner that appears ONLY while the self-host license is in its
// post-expiry grace window — the operator's one chance to notice a lapsed
// renewal before EE features deactivate two weeks later. Mounted inside the
// org admin area (already admin-gated), it reads state from the fail-closed
// status endpoint: on Cloud, unlicensed, valid, or any error it returns a
// non-grace status and this renders nothing.

export function LicenseGraceBanner() {
  const params = useParams();
  const pathname = usePathname();
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/license/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<LicenseStatus>) : null))
      .then((s) => {
        if (active && s) setStatus(s);
      })
      .catch(() => {
        // Fail closed — no banner if we can't determine state.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status || !status.visible || status.state !== "grace") return null;

  const orgName = typeof params.orgName === "string" ? params.orgName : undefined;
  const licensePath = orgName ? `/orgs/${orgName}/settings/license` : undefined;
  // Don't render a "View" link that points at the page you're already on.
  const showViewLink = licensePath && pathname !== licensePath;

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, pt: 2 }}>
      <Alert
        severity="warning"
        action={showViewLink ? <Link href={licensePath}>View</Link> : undefined}
      >
        Your OuterLayer Enterprise license expired and is in its grace period —
        Enterprise features deactivate in {status.daysUntilGraceEnds}{" "}
        {status.daysUntilGraceEnds === 1 ? "day" : "days"}.{" "}
        <a href="mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise%20renewal">
          Renew to avoid interruption
        </a>
        .
      </Alert>
    </Box>
  );
}
