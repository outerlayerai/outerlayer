/**
 * Per-session trajectory signals derived from a session's span rows — pure
 * functions, deterministic, no LLM. Signal definitions are pinned in
 * packages/observability-service/docs/trajectory-signals.md; the counters
 * (interventions, denials, tool errors, API errors) come from the
 * agent_session_summary rollup, while the pattern signals here need the
 * span sequence the rollup deliberately doesn't keep.
 */

/** The slice of a span row these signals read. Rows MUST be in time order —
 * the detail query orders by Timestamp, and "consecutive" depends on it. */
export interface TrajectorySpan {
  name: string;
  statusCode: string;
  metadata: Record<string, string>;
}

interface EditRetryLoop {
  file: string;
  /** Consecutive failed edits to `file` with no success in between. */
  fails: number;
}

/**
 * Longest run of consecutive FAILED edits to a single file — the agent stuck
 * retrying an edit it can't land (usually a stale anchor). Every attempt
 * burns tokens for zero progress. Same definition and default threshold
 * (≥3) as the findings detector `edit-retry-loop`, restated over span rows:
 * an edit is `Metadata.isEdit = '1'` with a file; a failure is a span-level
 * error status; any non-error edit to that file (including a rejected one)
 * resets its run. Returns null below the threshold — presence IS the signal.
 */
export function findEditRetryLoop(spans: TrajectorySpan[], minRun = 3): EditRetryLoop | null {
  const failsByFile = new Map<string, number>();
  let worst: EditRetryLoop | null = null;
  for (const s of spans) {
    if (!s.name.startsWith("agent.tool.")) continue;
    const file = s.metadata.isEdit === "1" ? s.metadata.file : undefined;
    if (!file) continue;
    const isError = s.statusCode === "2" || s.metadata.toolStatus === "error";
    if (!isError) {
      failsByFile.set(file, 0);
      continue;
    }
    const fails = (failsByFile.get(file) ?? 0) + 1;
    failsByFile.set(file, fails);
    if (!worst || fails > worst.fails) worst = { file, fails };
  }
  return worst && worst.fails >= minRun ? worst : null;
}
