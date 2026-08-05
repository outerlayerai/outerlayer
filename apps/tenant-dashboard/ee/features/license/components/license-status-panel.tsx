import { Alert, Card, Chip, Divider, Stack, Typography } from "@mui/material";
import { LocalDate } from "@/components/local-date";

import type { LicenseStatus } from "../types";

// Server-rendered (no "use client"): the settings page passes an already
// resolved status, and static MUI leaves render fine in a React Server Component (RSC). The dates are
// the exception — `LocalDate` is a client island, so each one renders in the
// visitor's own timezone after mount rather than the server's. Formatting a
// date here would put the server's zone in the HTML and hydrate into a
// mismatch, and on a date-only format it can name the wrong day outright.

const CONTACT_HREF = "mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise%20license";

// Kept as a label (not a live import of LICENSE_GRACE_DAYS) so the copy reads
// naturally; the authoritative window lives in @repo/ee-license and is asserted
// in the license-status service tests.
const LICENSE_GRACE_LABEL = "14-day";

/** "1 day" / "N days" — keeps the countdown copy grammatical. */
function dayCount(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 500, textAlign: "right" }}>
        {value}
      </Typography>
    </Stack>
  );
}

/**
 * The self-host license status panel. Renders one of three states: valid
 * (with an expiry countdown that warns when close), in-grace (expired but EE
 * still active until the grace end), or unlicensed. Callers only reach this
 * with a `visible: true` status — the page hides the whole surface on Cloud.
 */
export function LicenseStatusPanel({ status }: { status: Extract<LicenseStatus, { visible: true }> }) {
  if (status.state === "unlicensed") {
    return (
      <Card variant="outlined" sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Chip label="Unlicensed" size="small" color="default" />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            This instance has no enterprise license, so Enterprise features
            (custom roles, app-level roles, SSO, and the audit log) are locked.
            Everything else runs unlimited.
          </Typography>
          <Alert severity="info" sx={{ mt: 1 }}>
            To unlock Enterprise features,{" "}
            <a href={CONTACT_HREF}>contact us for a license key</a>, then set{" "}
            <code>OUTERLAYER_EE_LICENSE_KEY</code> on this deployment.
          </Alert>
        </Stack>
      </Card>
    );
  }

  if (status.state === "grace") {
    return (
      <Card variant="outlined" sx={{ p: 3, borderColor: "warning.main" }}>
        <Stack spacing={2}>
          <Chip label="In grace period" size="small" color="warning" />
          <Stack spacing={1}>
            <Row label="Licensed to" value={status.org} />
            <Row label="Plan" value="Enterprise" />
            <Divider />
            <Row label="Expired" value={<LocalDate value={status.expiredAt} format="date" />} />
            <Row label="Grace ends" value={<LocalDate value={status.graceEndsAt} format="date" />} />
          </Stack>
          <Alert severity="warning" sx={{ mt: 1 }}>
            This license expired on <LocalDate value={status.expiredAt} format="date" />. Enterprise
            features keep working for {dayCount(status.daysUntilGraceEnds)} — until{" "}
            <LocalDate value={status.graceEndsAt} format="date" /> — then deactivate. Your data is never
            touched. <a href={CONTACT_HREF}>Renew to avoid interruption</a>.
          </Alert>
        </Stack>
      </Card>
    );
  }

  // Valid — warn as expiry approaches (within the grace window's length).
  const expiringSoon = status.daysUntilExpiry <= 14;
  return (
    <Card variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Chip label="Active" size="small" color="success" />
        <Stack spacing={1}>
          <Row label="Licensed to" value={status.org} />
          <Row label="Plan" value="Enterprise" />
          <Divider />
          <Row
            label="Expires"
            value={
              <>
                <LocalDate value={status.expiresAt} format="date" /> (in{" "}
                {dayCount(status.daysUntilExpiry)})
              </>
            }
          />
        </Stack>
        {expiringSoon && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            This license expires in {dayCount(status.daysUntilExpiry)}. After that
            a {LICENSE_GRACE_LABEL} grace period keeps Enterprise features active,
            then they deactivate. <a href={CONTACT_HREF}>Renew now</a> to stay
            uninterrupted.
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
