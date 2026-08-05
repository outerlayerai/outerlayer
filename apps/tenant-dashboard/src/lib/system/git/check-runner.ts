import "server-only";

/**
 * Provider-agnostic interface for posting context-sync status back to the git
 * host on every push.
 *
 * **What it reports.** The commit check is repurposed: it reflects the mirror
 * sync outcome for the push (aggregated across every app watching the pushed
 * branch), not a deploy pipeline. `start(headSha)` opens an in-progress check;
 * `complete({conclusion, summary})` closes it with the aggregate result and a
 * human-readable per-app summary the core assembles.
 *
 * **Why the seam.** The push core is provider-agnostic; the only place provider
 * knowledge leaks is the rendering layer — POSTing to GitHub's Checks API.
 * This interface IS that seam: same lifecycle, same three conclusions, each
 * runner renders natively.
 */
export interface CheckRunner {
  /**
   * Open an in-progress check on the commit the runner was constructed for.
   * Provider-specific identifiers (owner/repo, projectId) are constructor
   * args — `start()` only needs the head SHA.
   *
   * Throws on failure. Callers wrap in try/catch for graceful degradation (a
   * status-API outage MUST NOT abort the sync itself).
   */
  start(headSha: string): Promise<CheckRunRef>;

  /**
   * Mark the check completed. `summary` is the aggregate per-app sync report
   * the core built — GitHub renders it in the Checks API `output.summary`.
   */
  complete(args: CompleteArgs): Promise<void>;
}

/**
 * Opaque token returned by `start()`. Each provider's `complete()` knows
 * how to interpret its own ref — GitHub uses the numeric check_run_id.
 * Callers treat it as a black box.
 */
export interface CheckRunRef {
  id: string | number;
}

export interface CompleteArgs {
  ref: CheckRunRef;
  conclusion: "success" | "failure" | "neutral";
  /** Aggregate per-app sync summary. Runners render it in their
   *  description/output; omitted → each runner's default for the conclusion. */
  summary?: string;
}

/** Stable check name. Referenced by user-side branch protection / required
 *  status check configuration. Lives here (not on each runner) because the
 *  name has to be identical across providers — branch protection rules name
 *  the check string-by-string. */
export const CHECK_NAME = "OuterLayer context sync";
