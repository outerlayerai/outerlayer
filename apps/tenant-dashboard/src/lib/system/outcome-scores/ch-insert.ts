import "server-only";

import { createClickHouseClient } from "@/lib/analytics/client";
import type { ScoresInsertFn } from "./emit";

/**
 * Real ClickHouse insert behind the seam. Writes go through the default
 * (write-capable) client — the tenant read client is row-policy scoped and
 * read-only. Returns null when ClickHouse isn't configured so callers skip
 * emission instead of failing their trigger (webhook, cron).
 */
export function scoresInsertFn(): ScoresInsertFn | null {
  const client = createClickHouseClient();
  if (!client) return null;
  return async (rows) => {
    await client.insert({ table: "scores", values: rows, format: "JSONEachRow" });
  };
}
