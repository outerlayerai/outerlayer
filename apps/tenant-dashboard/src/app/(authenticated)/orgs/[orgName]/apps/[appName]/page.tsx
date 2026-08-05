import { redirect } from "next/navigation";

// Server component — import the constant from the plain module, NOT from the
// `'use client'` env-context (that yields a client-reference stub here).
import { DEFAULT_ENV_NAME } from "@/lib/environments/default-env-name";

/**
 * Bare app root. Environments are a path segment as of the env-routing
 * migration (`/orgs/[orgName]/apps/[appName]/env/[envName]/...`), so the app
 * root itself renders nothing — it redirects into the default environment's
 * overview. This is the single entry point that gives the breadcrumb and
 * sidebar a concrete env to resolve; every in-app link already carries an
 * env segment.
 */
export default async function AppRootPage({
  params,
}: {
  params: Promise<{ orgName: string; appName: string }>;
}) {
  const { orgName, appName } = await params;
  redirect(
    `/orgs/${orgName}/apps/${appName}/env/${DEFAULT_ENV_NAME}`,
  );
}
