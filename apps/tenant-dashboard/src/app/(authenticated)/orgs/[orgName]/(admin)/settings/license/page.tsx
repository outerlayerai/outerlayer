import { notFound } from "next/navigation";

import { resolveLicenseStatus } from "@ee/features/license/service";
import { LicenseStatusPanel } from "@ee/features/license/components/license-status-panel";

export const metadata = {
  title: "Settings: License",
};

// Resolved per-request from server-only env (the license key never reaches the
// client), so it must not be statically cached.
export const dynamic = "force-dynamic";

export default async function LicenseSettingsPage() {
  const status = await resolveLicenseStatus();

  // Cloud (or any non-self-host) has no license surface. The nav tab is hidden
  // there too; this is the defense-in-depth for a direct URL hit.
  if (!status.visible) notFound();

  return <LicenseStatusPanel status={status} />;
}
