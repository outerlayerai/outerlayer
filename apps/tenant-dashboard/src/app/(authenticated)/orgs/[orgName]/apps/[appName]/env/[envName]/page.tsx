import { redirect } from "next/navigation";

/**
 * Env root. The product home is Dashboards, so the bare env segment forwards
 * there. The app root already forwarded into the default env; this completes
 * the chain `/apps/x` → `/apps/x/env/y` → `/apps/x/env/y/dashboards`.
 */
export default async function EnvRootPage({
  params,
}: {
  params: Promise<{ orgName: string; appName: string; envName: string }>;
}) {
  const { orgName, appName, envName } = await params;
  redirect(`/orgs/${orgName}/apps/${appName}/env/${envName}/dashboards`);
}
