import { describe, it, expect, vi, afterEach } from 'vitest';

import { retryingFetch } from '../retrying-fetch';

/** Minimal Response-shaped stub with a cancellable body. */
function resp(status: number): Response {
  return {
    status,
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('retryingFetch', () => {
  it('returns a 200 on the first attempt without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200));
    globalThis.fetch = fetchMock;

    const res = await retryingFetch('http://x', undefined, 4, 1);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 502 and returns the eventual 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(502))
      .mockResolvedValueOnce(resp(502))
      .mockResolvedValueOnce(resp(200));
    globalThis.fetch = fetchMock;

    const res = await retryingFetch('http://x', undefined, 4, 1);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a PostgREST logic error (409) — surfaces it on attempt one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(409));
    globalThis.fetch = fetchMock;

    const res = await retryingFetch('http://x', undefined, 4, 1);

    expect(res.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 504 timeout (a timed-out write may have committed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(504));
    globalThis.fetch = fetchMock;

    const res = await retryingFetch('http://x', undefined, 4, 1);

    expect(res.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown network error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(resp(200));
    globalThis.fetch = fetchMock;

    const res = await retryingFetch('http://x', undefined, 4, 1);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last 502 after exhausting retries (honest failure)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(502));
    globalThis.fetch = fetchMock;

    const res = await retryingFetch('http://x', undefined, 3, 1);

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('re-throws the network error after exhausting retries', async () => {
    const err = new Error('fetch failed');
    const fetchMock = vi.fn().mockRejectedValue(err);
    globalThis.fetch = fetchMock;

    await expect(retryingFetch('http://x', undefined, 3, 1)).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
