import "server-only";

import type { getAdminDataClient } from "@/lib/system/admin-client";
import { serverLogger } from "@/lib/observability/server-logger";

import type { EvidenceEvaluation } from "./evaluate";

/**
 * Persists each evidence evaluation to `pr_evidence_evaluation` — the
 * queryable record behind "did flagged PRs go bad more often". Recorded at
 * evaluation time, BEFORE and independent of the GitHub write: a verdict on
 * a not-yet-permitted installation is still a verdict, and the measurement
 * question needs those too.
 *
 * Append-only with a change gate, not a log of every refresh: the three
 * trigger paths re-evaluate the same PR constantly and the evaluation is
 * deterministic, so identical consecutive evaluations carry no information.
 * A row is written only when the verdict or facts differ from the latest
 * recorded one — the stored history is the sequence of DISTINCT evaluations,
 * each stamped when it was first computed.
 */

type AdminClient = ReturnType<typeof getAdminDataClient>;

interface RecordEvaluationParams {
  tenantId: string;
  repository: string;
  prNumber: number;
}

/**
 * JSON with recursively sorted object keys — a canonical spelling for
 * change detection. Postgres jsonb re-orders keys at rest, so comparing
 * `JSON.stringify` of a stored row against a fresh evaluation would see a
 * "change" in every key permutation and defeat the gate.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Records `evaluation` for this PR unless it is identical to the latest
 * recorded one.
 *
 * Best-effort by contract: a recording failure is logged as its own
 * structured event and NEVER propagated — the comment on the PR is the
 * user-facing artifact and must not be lost to a telemetry write. The
 * throw-free posture matches `refreshPrSessionComment`'s own.
 */
export async function recordEvidenceEvaluation(
  admin: AdminClient,
  params: RecordEvaluationParams,
  evaluation: EvidenceEvaluation,
): Promise<void> {
  const { tenantId, repository, prNumber } = params;
  try {
    const { data: latest, error: readError } = await admin
      .from("pr_evidence_evaluation")
      .select("verdict, facts, pending_link_count")
      .eq("tenant_id", tenantId)
      .eq("repository", repository)
      .eq("pr_number", prNumber)
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) {
      throw new Error(`pr_evidence_evaluation read failed: ${readError.message}`);
    }

    const unchanged =
      latest !== null &&
      latest.verdict === evaluation.verdict &&
      latest.pending_link_count === evaluation.pendingLinkCount &&
      canonicalJson(latest.facts) === canonicalJson(evaluation.facts);
    if (unchanged) return;

    const { error: insertError } = await admin.from("pr_evidence_evaluation").insert({
      tenant_id: tenantId,
      repository,
      pr_number: prNumber,
      verdict: evaluation.verdict,
      facts: JSON.parse(JSON.stringify(evaluation.facts)),
      pending_link_count: evaluation.pendingLinkCount,
    });
    if (insertError) {
      throw new Error(`pr_evidence_evaluation insert failed: ${insertError.message}`);
    }
  } catch (error) {
    await serverLogger.error(error instanceof Error ? error : new Error(String(error)), {
      context: "[pr-session-comment] evidence evaluation could not be recorded",
      event: "pr_evidence_evaluation.record_failed",
      tenantId,
      repository,
      prNumber,
    });
  }
}
