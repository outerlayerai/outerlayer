/**
 * Transcript tee + upload, for cloud-run fidelity.
 *
 * Accumulates the agent's raw stdout lines (the stream-json transcript) and,
 * after the run, ships them gzip+base64 to the dashboard's
 * /api/internal/worker-transcript, where the same @outerlayer/capture
 * adapters that parse seat sessions rebuild a full-fidelity AgentSession.
 *
 * Degradation over truncation: past the raw cap we STOP collecting and skip
 * the upload entirely — a torn JSONL tail parses worse than the
 * normalized-event fallback renders. Upload is best-effort (one retry, never
 * throws): a lost transcript costs fidelity, never the run.
 */

import { gzipSync } from 'node:zlib';

/** Raw cap (bytes of JSONL). 64 MiB covers multi-hour sessions with headroom;
 * gzip+base64 of that stays under the server's 24 MiB body cap. */
const MAX_TRANSCRIPT_RAW_BYTES = 64 * 1024 * 1024;

export class TranscriptTee {
  private lines: string[] = [];
  private bytes = 0;
  private dropped = false;

  constructor(private readonly maxBytes: number = MAX_TRANSCRIPT_RAW_BYTES) {}

  add(line: string): void {
    if (this.dropped) return;
    this.bytes += line.length + 1;
    if (this.bytes > this.maxBytes) {
      this.dropped = true;
      this.lines = [];
      return;
    }
    this.lines.push(line);
  }

  /** True when the transcript blew the cap and was discarded. */
  get overflowed(): boolean {
    return this.dropped;
  }

  get isEmpty(): boolean {
    return this.lines.length === 0;
  }

  toGzipBase64(): string {
    return gzipSync(Buffer.from(this.lines.join('\n') + '\n', 'utf8')).toString('base64');
  }
}

export interface UploadTranscriptOptions {
  url: string;
  workerSecret: string;
  workerRunId: string;
  fetchImpl?: typeof fetch;
}

/** POST the tee'd transcript. Best-effort: one retry, all failures swallowed
 * (returns false) — the server's event-bridge fallback covers the gap. */
export async function uploadTranscript(
  tee: TranscriptTee,
  opts: UploadTranscriptOptions,
): Promise<boolean> {
  if (tee.isEmpty || tee.overflowed) return false;
  const fetchFn = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    worker_run_id: opts.workerRunId,
    encoding: 'gzip+base64',
    data: tee.toGzipBase64(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchFn(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.workerSecret}` },
        body,
      });
      if (res.ok) return true;
      // 4xx is deterministic (bad payload/auth) — retrying can't help.
      if (res.status < 500) return false;
    } catch {
      // transient transport error — fall through to the retry
    }
  }
  return false;
}
