/**
 * WorkerDispatchAdapter — the port between "a worker run should execute" and
 * "compute is running it". Every implementation shares the same Liskov
 * contract:
 *
 *   1. Success returns the same minimal {@link WorkerDispatchResult} from
 *      every implementation.
 *   2. Failure throws only {@link WorkerDispatchError} with a closed-union
 *      `kind` — never a raw provider error.
 *   3. Dispatch is at-least-once, never exactly-once: a retry after a thrown
 *      error may execute the run twice, so everything downstream must be
 *      idempotent on `workerRunId` (the event-batch unique constraint and the
 *      callback's terminal-state guard provide this).
 *
 * `triggerWorker` only *dispatches*; the terminal status arrives later via
 * the worker callback route.
 */

export interface WorkerDispatchParams {
  /** Idempotency key for the run (worker_run.id). */
  workerRunId: string;
  appId: string;
  /**
   * Present when the dispatch targets a persistent environment's durable
   * machine. machineRef null = the environment has no
   * machine yet: the adapter creates one WITH a volume (auto_destroy off)
   * and returns its id. machineRef set = reuse: refresh the per-turn env
   * (one-time token) and start the stopped machine. envId names the
   * machine + volume deterministically so teardown can find them even if
   * refs are lost. Adapters without durable compute (local) ignore it.
   */
  persistentMachine?: { machineRef: string | null; envId: string };
  /**
   * Opaque transport for the runner's params payload
   * ({@link workerParamsPayloadSchema} is the authoritative shape). The port
   * does not inspect it: Fly stashes it in Vault behind the one-time token;
   * local passes it inline to the child process.
   */
  workerPayload: Record<string, unknown>;
}

export interface WorkerDispatchResult {
  /** Opaque correlation handle for logs; NOT awaited to completion. */
  dispatchId: string;
  /**
   * Fly machine id when the implementation provisions one (recorded on the
   * run row so cancel/reaper can destroy it). Absent for local dispatch.
   */
  machineId?: string;
}

export type WorkerDispatchErrorKind =
  | "misconfigured"
  | "unavailable"
  | "dispatch-failed";

export class WorkerDispatchError extends Error {
  readonly kind: WorkerDispatchErrorKind;
  readonly workerRunId: string;

  constructor(kind: WorkerDispatchErrorKind, message: string, workerRunId: string) {
    super(message);
    this.name = "WorkerDispatchError";
    this.kind = kind;
    this.workerRunId = workerRunId;
  }
}

export function isWorkerDispatchError(error: unknown): error is WorkerDispatchError {
  return error instanceof WorkerDispatchError;
}

export interface WorkerDispatchAdapter {
  triggerWorker(params: WorkerDispatchParams): Promise<WorkerDispatchResult>;
}

/**
 * Vault entry holding `JSON.stringify({ token, payload })` for the one-time
 * boot handshake — the machine trades WORKER_TOKEN for the params payload,
 * and the entry is deleted on first read (mirrors build_token_<deploymentId>).
 */
export function workerTokenVaultName(workerRunId: string): string {
  return `worker_token_${workerRunId}`;
}

/**
 * Vault entry holding the per-run secret the runner presents on the
 * event-batch and callback routes. Deleted when the run reaches a terminal
 * state (callback apply / reaper).
 */
export function workerSecretVaultName(workerRunId: string): string {
  return `worker_secret_${workerRunId}`;
}
