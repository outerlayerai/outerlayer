/**
 * useEnvironments — list envs for an app via gateway `GET /v1/environments`.
 *
 * The dashboard hits the gateway directly — there is no parallel Next.js
 * API route for env reads.
 *
 * Returned `data` is `Environment[]` — the canonical envelope's outer wrapper
 * (`{data, pagination}`) is unwrapped here so consumers see plain rows. The
 * pagination metadata is intentionally not surfaced: env counts per app are
 * bounded by an entitlement limit (single-digit by default), so the
 * list endpoint returns the full set without a UX pagination need.
 */

import useSWR from 'swr';

import { listEnvironments, GatewayError } from '@/lib/api/gateway-client';
import { useUrlTenantId } from '@/lib/app-shell/use-url-tenant-id';
import type { Environment } from '@/types/environment';

async function fetcher(
  [, appId, tenantId]: readonly ['/v1/environments', string, string | undefined],
): Promise<Environment[]> {
  return listEnvironments(appId, tenantId);
}

export function useEnvironments(appId: string) {
  // Send the URL-org tenant so the read is scoped to the viewed org, not the
  // session-global claim. Part of the SWR key so a tenant switch refetches.
  const tenantId = useUrlTenantId();
  // Key is null while appId is empty — SWR treats null keys as "don't fetch".
  // This handles the brief window between mount and AppContext resolving.
  const key = appId ? (['/v1/environments', appId, tenantId] as const) : null;

  const { data, error, isLoading, mutate } = useSWR<
    Environment[],
    GatewayError,
    typeof key
  >(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });

  return { data, error, isLoading, mutate };
}
