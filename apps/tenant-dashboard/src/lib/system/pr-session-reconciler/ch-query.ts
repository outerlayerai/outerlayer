import "server-only";

import {
  createTenantReadClient,
  getDefaultClient,
  type ClickHouseClient,
} from "@/lib/analytics/client";
import type { ChQueryFn } from "./reconciler";

function toQueryFn(client: ClickHouseClient | null): ChQueryFn | null {
  if (!client) return null;
  return async (sql, params) => {
    const result = await client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    return (await result.json()) as Record<string, unknown>[];
  };
}

/** Tenant-scoped reads for the per-PR direction (webhook context) — row
 * policies enforce the tenant boundary even on this service path. */
export function tenantChQuery(scope: { tenantId: string; appId?: string }): ChQueryFn | null {
  return toQueryFn(createTenantReadClient(scope));
}

/** Unscoped reads for the cron sweep: recently-ingested sessions span every
 * tenant, and the rows already carry TenantId/AppId for per-app fan-out. */
export function sweepChQuery(): ChQueryFn | null {
  return toQueryFn(getDefaultClient());
}
