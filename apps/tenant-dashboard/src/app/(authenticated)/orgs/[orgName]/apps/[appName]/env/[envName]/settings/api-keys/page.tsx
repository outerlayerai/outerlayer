import { Suspense } from "react";
import { Alert } from "@mui/material";

import { ApiKeysList, ApiKeysLoading } from "@/features/api-keys";
import { loadApiKeys } from "@/features/api-keys/read";

export const metadata = {
  title: "API Keys",
};

/**
 * API Keys settings page.
 *
 * Default-env-only posture: the multi-env UI is removed, so the `/env/<name>/`
 * path segment is never a user choice — API keys always resolve the app's
 * default env (envParam undefined). A hand-typed `/env/<other>/` URL can't
 * scope this page to another env.
 */
async function ApiKeysContent({ appName }: { appName: string }) {
  const result = await loadApiKeys(appName, undefined);

  if (result.unresolved) {
    return (
      <Alert severity="warning">
        Could not resolve the selected environment. Pick an environment from
        the breadcrumb to manage its API keys.
      </Alert>
    );
  }

  return (
    <ApiKeysList apiKeys={result.apiKeys} environmentName={result.environmentName} />
  );
}

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ orgName: string; appName: string; envName: string }>;
}) {
  const { appName } = await params;
  return (
    <Suspense fallback={<ApiKeysLoading />}>
      <ApiKeysContent appName={appName} />
    </Suspense>
  );
}
