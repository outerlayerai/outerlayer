/**
 * Reporter: seq assignment, batch flushing with a stubbed fetch + timers,
 * callback retry/backoff, and the best-effort guarantee (a failing endpoint
 * never throws to the caller).
 */

import { Reporter } from '../reporter.js';

function fakeTimers() {
  const callbacks: Array<() => void> = [];
  return {
    tick: () => callbacks.forEach((cb) => cb()),
    timers: {
      setInterval: (fn: () => void) => {
        callbacks.push(fn);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        callbacks.length = 0;
      },
    },
  };
}

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
}

const BASE = {
  eventsUrl: 'http://d/api/internal/worker-events',
  callbackUrl: 'http://d/api/internal/worker-callback',
  workerSecret: 'secret-1',
  workerRunId: 'run-1',
  appId: 'app-1',
};

describe('Reporter events', () => {
  it('assigns a per-run monotonic seq across enqueue calls and posts them with bearer auth', async () => {
    const fetchImpl = okFetch();
    const reporter = new Reporter({ ...BASE, fetchImpl });

    reporter.enqueue([
      { event_type: 'status', payload: { phase: 'started' } },
      { event_type: 'agent-message', payload: { text: 'hi' } },
    ]);
    reporter.enqueue([{ event_type: 'result', payload: { result: 'done' } }]);
    await reporter.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(BASE.eventsUrl);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-1' });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.worker_run_id).toBe('run-1');
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([0, 1, 2]);
    expect(body.events[0].event_type).toBe('status');
    expect(reporter.pending).toBe(0);
  });

  it('flushes on the timer tick', async () => {
    const fetchImpl = okFetch();
    const { tick, timers } = fakeTimers();
    const reporter = new Reporter({ ...BASE, fetchImpl, timers });

    reporter.start();
    reporter.enqueue([{ event_type: 'status', payload: {} }]);
    tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps events buffered when the endpoint returns a non-409 error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
    const reporter = new Reporter({ ...BASE, fetchImpl });

    reporter.enqueue([{ event_type: 'status', payload: {} }]);
    await reporter.flush();

    expect(reporter.pending).toBe(1);
  });

  it('does not throw when fetch itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const onFlushError = vi.fn();
    const reporter = new Reporter({ ...BASE, fetchImpl, onFlushError });

    reporter.enqueue([{ event_type: 'status', payload: {} }]);
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(onFlushError).toHaveBeenCalledOnce();
  });
});

describe('Reporter.sendCallback', () => {
  it('flushes pending events first, then posts the callback, returning true on 2xx', async () => {
    const fetchImpl = okFetch();
    const reporter = new Reporter({ ...BASE, fetchImpl });
    reporter.enqueue([{ event_type: 'status', payload: {} }]);

    const ok = await reporter.sendCallback({
      worker_run_id: 'run-1',
      app_id: 'app-1',
      status: 'succeeded',
      outcome: 'no_changes',
      raw_log: '',
      duration_ms: 5,
    });

    expect(ok).toBe(true);
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([BASE.eventsUrl, BASE.callbackUrl]);
  });

  it('retries a failing callback and eventually returns false without throwing', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const reporter = new Reporter({ ...BASE, fetchImpl });

    const promise = reporter.sendCallback({
      worker_run_id: 'run-1',
      app_id: 'app-1',
      status: 'failed',
      raw_log: '',
      duration_ms: 1,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(false);
    // initial attempt + 3 retries
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
