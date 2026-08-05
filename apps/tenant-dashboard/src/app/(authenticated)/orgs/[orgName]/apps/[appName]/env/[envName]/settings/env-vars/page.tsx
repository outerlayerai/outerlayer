import { Suspense } from "react";
import { Alert, CircularProgress, Box } from "@mui/material";
import { getAppIdByName } from "@/utils/get-app-id";
import { getAppPermissionSet } from "@/utils/get-app-permissions";
import { resolveEnvIdForStorageAdmin } from "@/lib/system/resolve-env-scope";
import { loadEnvironmentNames, loadEnvVarsForApp } from "@/features/integrations/read";
import { EnvVarEditor } from "@/features/integrations/components/env-vars";

export const metadata = {
  title: "Environment Variables",
};

/**
 * Environment Variables settings page.
 *
 * Env vars are scoped to the breadcrumb-selected environment. The selection
 * lives in the `?env=` query param (the EnvContext / shareable-URL contract);
 * this server component reads it from `searchParams` and resolves it to an
 * `environment` row via the admin-client `resolveEnvIdForStorageAdmin` — the
 * storage variant intentionally returns a concrete env row id for the
 * default `dev` env so the `env_var.environment_id NOT NULL` foreign key
 * always resolves (a null envId for the default env would violate that
 * constraint and short-circuit the page). It runs on the service-role client
 * (mirroring the webhook section) because the env-var picker permissions do
 * not include `environment.read`; app_id is already authorized by the
 * `env_var.read` gate below, so this only resolves an id within an
 * already-authorized app rather than widening tenancy.
 *
 * Every other read below runs on the request-tenant RLS-scoped client: the
 * `env_var.read` gate below is a friendly early message, not the
 * enforcement boundary — the RLS policy on the underlying query is.
 */
export async function EnvVarsContent({
  appName,
  envParam,
}: {
  appName: string;
  envParam: string | undefined;
}) {
  // RLS-scoped lookup: resolves only apps the caller can read, so an app in
  // another tenant that happens to share the name can never be selected.
  const appId = await getAppIdByName(appName);

  if (!appId) return null;

  const perms = await getAppPermissionSet(appId);

  if (!perms.has("env_var.read")) {
    return (
      <Alert severity="warning">
        You don&apos;t have permission to view environment variables for this app.
      </Alert>
    );
  }

  // Resolve the breadcrumb-selected environment to a concrete row id. An
  // absent `?env=` falls back to the app's default env; a stale or
  // cross-tenant `?env=` returns null and we surface the warning below.
  const scope = await resolveEnvIdForStorageAdmin(appId, {
    envName: envParam ?? null,
  });

  if (!scope) {
    return (
      <Alert severity="warning">
        Could not resolve the selected environment. Pick an environment from the
        breadcrumb to manage its variables.
      </Alert>
    );
  }

  // All rows (specific-env AND kind-targeted) — the manager is app-wide; the
  // current env from the breadcrumb is only the "Only <env>" override target.
  const [envVars, envNames] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadEnvironmentNames(appId),
  ]);

  return (
    <EnvVarEditor
      appId={appId}
      currentEnvId={scope.envId}
      currentEnvName={scope.envName}
      envVars={envVars}
      envNames={envNames}
    />
  );
}

export default async function EnvVarsPage({
  params,
}: {
  params: Promise<{ orgName: string; appName: string; envName: string }>;
}) {
  const { appName } = await params;
  // Default-env-only posture: the multi-env UI is removed, so the `/env/<name>/`
  // path segment is never a user choice — always resolve the app's default env
  // (envParam undefined). A hand-typed `/env/<other>/` URL can't scope the page.
  const env = undefined;
  return (
    <Suspense
      fallback={
        <Box sx={{ p: 4, textAlign: "center" }}>
          <CircularProgress size={28} />
        </Box>
      }
    >
      <EnvVarsContent appName={appName} envParam={env} />
    </Suspense>
  );
}
