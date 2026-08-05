/**
 * Reports run progress back to the dashboard:
 *   - buffers normalized events and flushes batches to /worker-events on an
 *     interval (and on demand), assigning a per-run monotonic seq;
 *   - sends the terminal callback to /worker-callback with retry/backoff.
 * Both authenticate with the per-run worker_secret. Neither ever throws to the
 * caller — a lost event/callback must not crash the machine before auto_destroy
 * (the reaper backstops a fully-lost callback).
 */

import type { NormalizedEvent } from '../agents/types.js';
import type { WorkerCallbackPayload, WorkerEvent } from '../lib/schemas.js';

export interface ReporterOptions {
  eventsUrl: string;
  callbackUrl: string;
  workerSecret: string;
  workerRunId: string;
  appId: string;
  flushIntervalMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to real setInterval/clearInterval. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  };
  onFlushError?: (error: unknown) => void;
}

const MAX_BATCH = 500;

export class Reporter {
  private readonly opts: Required<Omit<ReporterOptions, 'onFlushError'>> &
    Pick<ReporterOptions, 'onFlushError'>;
  private seq = 0;
  private buffer: WorkerEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(options: ReporterOptions) {
    this.opts = {
      flushIntervalMs: options.flushIntervalMs ?? 2000,
      fetchImpl: options.fetchImpl ?? fetch,
      timers: options.timers ?? {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (handle) => clearInterval(handle),
      },
      onFlushError: options.onFlushError,
      eventsUrl: options.eventsUrl,
      callbackUrl: options.callbackUrl,
      workerSecret: options.workerSecret,
      workerRunId: options.workerRunId,
      appId: options.appId,
    };
  }

  /** Buffer normalized events, stamping each with the next seq. */
  enqueue(events: NormalizedEvent[]): void {
    for (const e of events) {
      this.buffer.push({ seq: this.seq++, event_type: e.event_type, payload: e.payload });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.opts.timers.setInterval(() => {
      void this.flush();
    }, this.opts.flushIntervalMs);
  }

  /** Flush all buffered events in chunks. Swallows errors (best-effort). */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, MAX_BATCH);
        const res = await this.opts.fetchImpl(this.opts.eventsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.opts.workerSecret}`,
          },
          body: JSON.stringify({ worker_run_id: this.opts.workerRunId, events: batch }),
        });
        if (!res.ok) {
          // Leave the batch buffered for the next tick; a 409 on a partial
          // replay is fine (unique seq makes inserts idempotent server-side).
          if (res.status !== 409) break;
        }
        this.buffer = this.buffer.slice(batch.length);
      }
    } catch (error) {
      this.opts.onFlushError?.(error);
    } finally {
      this.flushing = false;
    }
  }

  stop(): void {
    if (this.timer) {
      this.opts.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Flush remaining events, then POST the terminal callback with retries. */
  async sendCallback(payload: WorkerCallbackPayload): Promise<boolean> {
    this.stop();
    await this.flush();
    const backoffs = [1000, 2000, 4000];
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        const res = await this.opts.fetchImpl(this.opts.callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.opts.workerSecret}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) return true;
      } catch {
        // Network blip — retry.
      }
      if (attempt < backoffs.length) {
        await new Promise((resolve) => setTimeout(resolve, backoffs[attempt]));
      }
    }
    return false;
  }

  /** Test accessor: how many events are still buffered. */
  get pending(): number {
    return this.buffer.length;
  }
}
