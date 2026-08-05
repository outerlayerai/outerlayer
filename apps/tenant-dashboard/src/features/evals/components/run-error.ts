/**
 * The failure type a benchmark run throws.
 *
 * It lives apart from the runner client so the UI can carry the real type into
 * tests that stub the runner's network functions — a test-local stand-in class
 * would be free to disagree with this contract.
 */

/**
 * Why a run ended without a Report Card. The four are not interchangeable:
 * `poll_failed` means the status route refused the read and the run's own fate
 * is unknown; `timed_out` means the run was still going when the client gave
 * up; `run_failed` means the backend reported the run itself as failed;
 * `dispatch_failed` means it never started. Only the middle two say anything
 * about a run that is actually executing.
 */
type EvalRunFailureKind = "dispatch_failed" | "poll_failed" | "timed_out" | "run_failed";

/**
 * A run failure carrying whether another attempt could plausibly differ. The
 * UI reads `retryable` to decide whether to offer a Retry affordance — offering
 * one for a permission or routing failure only invites the identical refusal.
 */
export class EvalRunError extends Error {
  readonly kind: EvalRunFailureKind;
  readonly retryable: boolean;
  /** The poll response's HTTP status, when the failure came from one. */
  readonly status?: number;

  constructor(message: string, opts: { kind: EvalRunFailureKind; retryable: boolean; status?: number }) {
    super(message);
    this.name = "EvalRunError";
    this.kind = opts.kind;
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}
