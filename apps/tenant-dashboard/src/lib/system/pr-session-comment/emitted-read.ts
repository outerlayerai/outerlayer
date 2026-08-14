import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import type { EmittedResultRecord } from "@/lib/system/verdict/custom";

/**
 * Read layer for emitted validator results: every result recorded for
 * `(tenant, repository, pr_number)`, reduced to the LATEST per name — a CI
 * re-run supersedes its earlier report, and one name maps to one row on the
 * comment. Same admin-client rationale as `artifacts-read.ts`: the refresh
 * runs from webhook/queue contexts with no user session, so `tenantId` MUST
 * come from a verified source.
 *
 * Latest-per-name is resolved by (emitted_at, id) — fields that never
 * change after ingest — so re-reads of unchanged records pick the same
 * winner every time; determinism of the comment body depends on it.
 */

/** Bounded read — a comment refresh, never a full-table walk. */
const MAX_EMITTED_RESULTS = 100;

export async function readPrEmittedResults(params: {
  tenantId: string;
  repository: string;
  prNumber: number;
}): Promise<ReadonlyMap<string, EmittedResultRecord>> {
  const { tenantId, repository, prNumber } = params;
  const admin = getAdminDataClient();

  const { data, error } = await admin
    .from("emitted_result")
    .select("name, result, link, provenance, emitted_at, id")
    .eq("tenant_id", tenantId)
    .eq("repository", repository)
    .eq("pr_number", prNumber)
    .order("emitted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_EMITTED_RESULTS);
  if (error) {
    throw new Error(`emitted_result read failed: ${error.message}`);
  }

  // Rows arrive newest-first; the first occurrence of each name wins.
  const byName = new Map<string, EmittedResultRecord>();
  for (const row of data ?? []) {
    if (byName.has(row.name)) continue;
    // Clamp toward the WEAKER claim: the check constraints make other values
    // unreachable, but if one ever appears it must not read as a pass or as
    // CI-grade provenance.
    byName.set(row.name, {
      name: row.name,
      result: row.result === "pass" ? "pass" : "fail",
      link: row.link,
      provenance: row.provenance === "ci" ? "ci" : "local",
    });
  }
  return byName;
}
