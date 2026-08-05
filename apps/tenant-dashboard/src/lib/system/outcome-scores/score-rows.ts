import "server-only";

import { createHash } from "node:crypto";

/**
 * PR-outcome scores: ground-truth quality signals for coding-agent sessions,
 * materialized into the ClickHouse `scores` table at the (session, pull
 * request) grain — one row set per confirmed `pull_request_session` link, so
 * existing score-analytics surfaces aggregate them with no new read plumbing.
 *
 * Source `outcome` marks PROVENANCE — emitted by this writer off the
 * webhook-fed PR record — and nothing more. The public scores write API does
 * not accept it, so API callers cannot spoof system outcomes.
 *
 * Whether a given score may be used as a correlation PREDICTOR is a separate
 * question, answered by `SCORE_PREDICTIVE_ROLE` below, not by `Source`.
 *
 * Idempotency contract: ReplacingMergeTree collapse requires the FULL sort
 * key equal — (TenantId, AppId, toDate(CreatedAt), Name, Id). Two rules keep
 * re-emission collapse-safe no matter when or how often the emitter runs:
 *
 *  - `Id` is a deterministic hash of (app, trace, pr, name);
 *  - `CreatedAt` is anchored to the PR's `opened_at` — the one lifecycle
 *    timestamp that never moves (provider `created_at`; close→reopen→merge
 *    flips every other stamp). Anchoring to decision time instead would leave
 *    a re-emitted row on a different toDate() after a late flip, and the two
 *    rows would BOTH survive FINAL. A PR with no `opened_at` emits nothing.
 *
 * `UpdatedAt` is the replacing version (emission time): when a fact flips
 * (merged → reverted), the newer row wins the collapse.
 *
 * Score trends therefore bucket outcome scores by PR-open cohort, not
 * decision date.
 */

const OUTCOME_SCORE_SOURCE = "outcome";
const OUTCOME_SCORE_TYPE = "pr_outcome";

export const OUTCOME_SCORE_NAMES = {
  /** First-pass CI verdict on the PR: 1 = first completed conclusion was
   * success, 0 = failure. Absent = no CI signal observed (unknown, not red). */
  ciGreen: "worker.ci_green",
  /** Terminal fate: 1 = merged, 0 = closed without merging. Absent while the
   * PR is open. */
  merged: "worker.merged",
  /** Durability among merged PRs: 1 = a revert of this PR was detected,
   * 0 = merged and standing so far. Absent for unmerged PRs. */
  reverted: "worker.reverted",
} as const;

/**
 * Whether each score above is the OUTCOME being predicted or a PREDICTOR of
 * it. Correlation surfaces may segment outcomes by a `predictor`,
 * never by a `fate` — segmenting merge rate by `worker.merged` is a
 * tautology dressed up as a finding.
 *
 * The distinction is deliberately NOT encoded in `Source`: every score here
 * has the same provenance (this writer, from the webhook-fed PR record), so
 * `Source: 'outcome'` is the honest answer for all of them. Predictive-vs-
 * fate is a different question from who-emitted-this, and overloading one
 * field with both produces single-member categories and an exclusion rule
 * that only works by accident.
 *
 * `Record<keyof …>` keeps this exhaustive: adding a name to OUTCOME_SCORE_NAMES
 * without classifying it here is a compile error, so a new fate signal can
 * never silently become selectable as its own predictor.
 */
const SCORE_PREDICTIVE_ROLE: Record<keyof typeof OUTCOME_SCORE_NAMES, "fate" | "predictor"> = {
  // Lands on the first pushed sha, BEFORE the merge/close decision — real
  // pre-merge evidence, so a legitimate predictor of what follows.
  ciGreen: "predictor",
  merged: "fate",
  reverted: "fate",
};

/** Score names derived from a PR's fate — banned as a correlation predictor.
 * Module-private on purpose: callers ask `isFateDerivedScoreName` rather than
 * re-implementing the membership test against a raw set. */
const FATE_DERIVED_SCORE_NAMES: ReadonlySet<string> = new Set(
  (Object.keys(SCORE_PREDICTIVE_ROLE) as Array<keyof typeof OUTCOME_SCORE_NAMES>)
    .filter((key) => SCORE_PREDICTIVE_ROLE[key] === "fate")
    .map((key) => OUTCOME_SCORE_NAMES[key]),
);

/** True when `name` is a fate-derived score and must not be a predictor axis. */
export function isFateDerivedScoreName(name: string): boolean {
  return FATE_DERIVED_SCORE_NAMES.has(name);
}

export interface PrFateRow {
  tenant_id: string;
  app_id: string;
  pr_number: number;
  state: "open" | "closed" | "merged";
  opened_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  reverted_at: string | null;
  first_ci_status: "success" | "failure" | null;
}

export interface OutcomeScoreRow {
  Id: string;
  TenantId: string;
  AppId: string;
  ResourceId: string;
  Name: string;
  Score: number;
  Label: string;
  Reason: string;
  Type: string;
  Source: string;
  DataType: string;
  UserId: string;
  Environment: string;
  EnvironmentVersion: number;
  CommitSha: string;
  /** Epoch milliseconds (DateTime64(3) scale). */
  CreatedAt: number;
  UpdatedAt: number;
  IsDeleted: 0;
}

/**
 * Deterministic UUID-shaped Id from (app, trace, pr, name). A session links
 * MANY PRs and a PR many sessions, so every component is needed to keep ids
 * distinct: dropping `prNumber` would make two PRs' outcomes replace each other under
 * the same trace. Version/variant nibbles are pinned so consumers that
 * Zod-validate `.uuid()` on score ids keep working.
 */
export function outcomeScoreId(
  appId: string,
  traceId: string,
  prNumber: number,
  name: string,
): string {
  const hex = createHash("sha256")
    .update(`${appId}\n${traceId}\n${prNumber}\n${name}`)
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Score rows for one PR × its confirmed session traces. Emits only facts the
 * lifecycle record can back right now — an open PR yields at most the CI
 * verdict; an unknown never emits as a 0.
 */
export function outcomeScoreRows(
  pr: PrFateRow,
  traceIds: readonly string[],
  emittedAtMs: number,
): OutcomeScoreRow[] {
  if (!pr.opened_at || traceIds.length === 0) return [];
  const anchorMs = Date.parse(pr.opened_at);
  if (!Number.isFinite(anchorMs)) return [];

  // Every fact matches a KNOWN value, never "not open"/"not null" — an
  // unexpected or absent field must emit nothing, not a 0.
  const facts: Array<{ name: string; score: number; label: string }> = [];
  if (pr.first_ci_status === "success" || pr.first_ci_status === "failure") {
    facts.push({
      name: OUTCOME_SCORE_NAMES.ciGreen,
      score: pr.first_ci_status === "success" ? 1 : 0,
      label: pr.first_ci_status,
    });
  }
  if (pr.state === "merged" || pr.state === "closed") {
    facts.push({
      name: OUTCOME_SCORE_NAMES.merged,
      score: pr.state === "merged" ? 1 : 0,
      label: pr.state,
    });
  }
  if (pr.state === "merged") {
    facts.push({
      name: OUTCOME_SCORE_NAMES.reverted,
      score: pr.reverted_at !== null ? 1 : 0,
      label: pr.reverted_at !== null ? "reverted" : "standing",
    });
  }
  if (facts.length === 0) return [];

  const rows: OutcomeScoreRow[] = [];
  for (const traceId of traceIds) {
    for (const fact of facts) {
      rows.push({
        Id: outcomeScoreId(pr.app_id, traceId, pr.pr_number, fact.name),
        TenantId: pr.tenant_id,
        AppId: pr.app_id,
        ResourceId: traceId,
        Name: fact.name,
        Score: fact.score,
        Label: fact.label,
        Reason: "",
        Type: OUTCOME_SCORE_TYPE,
        Source: OUTCOME_SCORE_SOURCE,
        DataType: "boolean",
        UserId: "",
        Environment: "",
        EnvironmentVersion: 0,
        CommitSha: "",
        CreatedAt: anchorMs,
        UpdatedAt: emittedAtMs,
        IsDeleted: 0,
      });
    }
  }
  return rows;
}
