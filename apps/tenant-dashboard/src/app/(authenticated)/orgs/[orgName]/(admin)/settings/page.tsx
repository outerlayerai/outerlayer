import { redirect } from "next/navigation";

/**
 * Bare settings root. The account popover's "Organization settings" entry
 * links here (`paths.orgs.org.settings.root`), and every settings tab lives
 * under a named sub-path (`/settings/general`, `/settings/billing`, …) — this
 * page has no content of its own, it redirects into General.
 */
export default async function SettingsRootPage({
  params,
}: {
  params: Promise<{ orgName: string }>;
}) {
  const { orgName } = await params;
  redirect(`/orgs/${orgName}/settings/general`);
}
