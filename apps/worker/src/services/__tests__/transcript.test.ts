/**
 * Transcript tee + upload (AC-9 cloud fidelity): the raw stream-json lines
 * must survive the gzip+base64 round-trip byte-for-byte (the server parses
 * them with the real capture adapter), overflow must degrade to NO upload
 * (never a torn tail), and the upload must be best-effort.
 */
import { describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { TranscriptTee, uploadTranscript } from '../transcript.js';

const OPTS = { url: 'http://d/api/internal/worker-transcript', workerSecret: 's3cret', workerRunId: 'run-1' };

function okResponse(status = 200): Response {
  return { ok: status < 400, status } as Response;
}

describe('TranscriptTee', () => {
  it('round-trips lines byte-for-byte through gzip+base64', () => {
    const tee = new TranscriptTee();
    tee.add('{"type":"system","session_id":"s1"}');
    tee.add('{"type":"assistant","message":{"content":[]}}');
    const decoded = gunzipSync(Buffer.from(tee.toGzipBase64(), 'base64')).toString('utf8');
    expect(decoded).toBe('{"type":"system","session_id":"s1"}\n{"type":"assistant","message":{"content":[]}}\n');
  });

  it('discards everything past the cap instead of keeping a torn prefix', () => {
    const tee = new TranscriptTee(10);
    tee.add('12345');
    tee.add('123456789'); // 5+1 + 9+1 = 16 > 10
    expect(tee.overflowed).toBe(true);
    expect(tee.isEmpty).toBe(true);
    tee.add('more'); // stays dropped — no partial resurrection
    expect(tee.isEmpty).toBe(true);
  });
});

describe('uploadTranscript', () => {
  it('POSTs the canonical payload with worker-secret auth', async () => {
    const tee = new TranscriptTee();
    tee.add('{"type":"system"}');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return okResponse();
    }) as typeof fetch;

    await expect(uploadTranscript(tee, { ...OPTS, fetchImpl })).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPTS.url);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
    const body = JSON.parse(String(calls[0]!.init.body)) as { worker_run_id: string; encoding: string; data: string };
    expect(body.worker_run_id).toBe('run-1');
    expect(body.encoding).toBe('gzip+base64');
    expect(gunzipSync(Buffer.from(body.data, 'base64')).toString('utf8')).toBe('{"type":"system"}\n');
  });

  it('retries once on a 5xx, then gives up quietly', async () => {
    const tee = new TranscriptTee();
    tee.add('x');
    const fetchImpl = vi.fn(async () => okResponse(500)) as unknown as typeof fetch;
    await expect(uploadTranscript(tee, { ...OPTS, fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx (deterministic reject)', async () => {
    const tee = new TranscriptTee();
    tee.add('x');
    const fetchImpl = vi.fn(async () => okResponse(401)) as unknown as typeof fetch;
    await expect(uploadTranscript(tee, { ...OPTS, fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips the network entirely for empty or overflowed tees', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(uploadTranscript(new TranscriptTee(), { ...OPTS, fetchImpl })).resolves.toBe(false);
    const overflowed = new TranscriptTee(1);
    overflowed.add('too long');
    await expect(uploadTranscript(overflowed, { ...OPTS, fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows thrown transport errors after the retry', async () => {
    const tee = new TranscriptTee();
    tee.add('x');
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(uploadTranscript(tee, { ...OPTS, fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
