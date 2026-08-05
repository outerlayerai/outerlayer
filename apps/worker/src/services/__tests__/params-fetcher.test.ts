/**
 * fetchWorkerParams trades the single-use WORKER_TOKEN for the run's params.
 * It must demand all three boot env vars, hit the exact one-time-Vault URL with
 * a bearer token + timeout signal, surface a scrubbed error on a non-2xx, and
 * return the parsed JSON body on success.
 */

import { fetchWorkerParams } from '../params-fetcher.js';

const ENV = {
  WORKER_TOKEN: 'boot-token-abc',
  WORKER_RUN_ID: 'run-42',
  DASHBOARD_URL: 'https://dash.example.com',
} as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchWorkerParams preconditions', () => {
  it.each([
    ['WORKER_TOKEN', { WORKER_RUN_ID: 'r', DASHBOARD_URL: 'd' }],
    ['WORKER_RUN_ID', { WORKER_TOKEN: 't', DASHBOARD_URL: 'd' }],
    ['DASHBOARD_URL', { WORKER_TOKEN: 't', WORKER_RUN_ID: 'r' }],
  ])('throws (without calling fetch) when %s is missing', async (_missing, env) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWorkerParams(env as NodeJS.ProcessEnv)).rejects.toThrow(
      'ephemeral mode requires WORKER_TOKEN, WORKER_RUN_ID, and DASHBOARD_URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchWorkerParams request', () => {
  it('GETs the worker-params URL with a bearer token + timeout signal and returns the parsed body', async () => {
    const params = { worker_run_id: 'run-42', agent: 'claude-code', caps: { max_diff_files: 5 } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => params });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWorkerParams(ENV);

    expect(result).toEqual(params);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://dash.example.com/api/internal/worker-params?worker_run_id=run-42');
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer boot-token-abc' } });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('url-encodes a run id with reserved characters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await fetchWorkerParams({ ...ENV, WORKER_RUN_ID: 'a b/c&d' } as NodeJS.ProcessEnv);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://dash.example.com/api/internal/worker-params?worker_run_id=a%20b%2Fc%26d',
    );
  });

  it('throws a status-carrying, body-truncating error on a non-2xx response', async () => {
    const longDetail = 'x'.repeat(500);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => longDetail });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorkerParams(ENV)).rejects.toThrow(
      `Failed to fetch worker params: 403 — ${'x'.repeat(200)}`,
    );
  });

  it('still throws with the status when reading the error body itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('stream broke');
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorkerParams(ENV)).rejects.toThrow('Failed to fetch worker params: 500 —');
  });
});
