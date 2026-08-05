// @vitest-environment jsdom
/**
 * Error-boundary triage: which caught errors are the user's problem.
 *
 * A deploy landing mid-navigation breaks the stale bundle's next fetch. On its
 * FIRST occurrence that is not a fault of the page that happened to be loading,
 * so it reloads itself away silently — the reload is already fixing it, and
 * every boundary in the app has to agree on that or the nested ones intercept
 * the class before the root one can suppress it.
 *
 * The silence is conditional, not absolute. Once the attempt budget is spent and
 * the same error returns, the reloads did not fix anything and the fault is real.
 * The budget is bounded by its own age rather than by any signal that the app
 * came up, because a successful mount is not evidence of a good deploy — chunk
 * skew mounts the shell fine and fails afterwards on a lazy import. Same when the
 * reload guard cannot be read or written: that is reported under its own marker
 * rather than as a survived reload, so a storage-partitioned session stays
 * distinguishable from a broken deploy.
 */
import { renderHook } from '@testing-library/react';

import { resetPageLoadRecoveryState } from '@/app/deployment-skew';
import { useErrorBoundaryRecovery } from './use-error-boundary-recovery';

const logError = vi.fn();
vi.mock('@/hooks/use-client-logger', () => ({
  useClientLogger: () => ({ error: logError }),
}));

const reload = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
  resetPageLoadRecoveryState();
  vi.stubGlobal('location', { ...window.location, reload });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Spies must be restored here, not at the end of the test that installs them:
  // an assertion failing first would skip an inline restore and leak a throwing
  // `getItem`/`setItem` into later cases, silently moving them onto a different
  // branch. `clearAllMocks` resets calls but leaves the implementation in place.
  vi.restoreAllMocks();
});

function skewError(): Error {
  return Object.assign(new Error('Loading chunk 42 failed'), { name: 'ChunkLoadError' });
}

/**
 * A real reload replaces the JS context, so everything page-load-scoped resets
 * while session storage survives. Tests share one module instance and have to
 * say so explicitly.
 */
function simulateReload(): void {
  resetPageLoadRecoveryState();
}

it('reloads a deployment-skew error away without reporting it', () => {
  const { result } = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));

  expect(result.current.isReloading).toBe(true);
  expect(logError).not.toHaveBeenCalled();

  vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('treats an RSC stream closing mid-flight the same way', () => {
  const { result } = renderHook(() =>
    useErrorBoundaryRecovery(new Error('Connection closed.'), 'a-boundary'),
  );

  expect(result.current.isReloading).toBe(true);
  expect(logError).not.toHaveBeenCalled();

  vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reports a genuine fault to the logger with its digest and the caller source', () => {
  const error = Object.assign(new Error('ClickHouse unavailable'), { digest: 'abc123' });

  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'agent-sessions-boundary'));

  expect(result.current.isReloading).toBe(false);
  expect(logError).toHaveBeenCalledWith(error, {
    digest: 'abc123',
    source: 'agent-sessions-boundary',
  });

  vi.advanceTimersByTime(500);
  expect(reload).not.toHaveBeenCalled();
});

it('reports the third occurrence, once both reloads are spent', () => {
  const first = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  first.unmount();
  simulateReload();

  const second = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  second.unmount();
  simulateReload();
  expect(reload).toHaveBeenCalledTimes(2);
  logError.mockClear();

  const error = Object.assign(skewError(), { digest: 'deploy-9' });
  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  vi.advanceTimersByTime(10_000);
  expect(reload).toHaveBeenCalledTimes(2);
  expect(logError).toHaveBeenCalledWith(error, {
    digest: 'deploy-9',
    source: 'a-boundary',
    unrecoveredSkew: true,
    reloadableClass: 'deployment-skew',
    // Stamp age separates a tight loop-break from a late recurrence at triage.
    msSinceLastReload: 500,
    reloadAttempts: 2,
    // Sentry's beforeSend keys off this to keep the event at `error` instead of
    // filing it as a self-healed warning.
    automaticRecovery: 'exhausted',
  });
});

it('caps reloads within the TTL but allows two more past it — a rate bound, not a total', () => {
  // The bound this module provides is a RATE. Inside the TTL the count holds
  // however late the re-failure arrives, so a broken deploy cannot spin. Past the
  // TTL the count is discarded on purpose, because that is what lets a long-lived
  // session recover from a genuinely separate deploy — which also means an
  // incident re-failing more slowly than the TTL is slowed, not capped. Pinning
  // both halves here so the tradeoff is stated rather than discovered.
  const spendBudget = () => {
    for (let i = 0; i < 2; i += 1) {
      const boundary = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
      vi.advanceTimersByTime(500);
      boundary.unmount();
      simulateReload();
    }
  };

  spendBudget();
  expect(reload).toHaveBeenCalledTimes(2);

  // A minute later — far past any plausible reload window, still inside the TTL.
  vi.advanceTimersByTime(60_000);
  const capped = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  expect(capped.result.current.isReloading).toBe(false);
  vi.advanceTimersByTime(10_000);
  expect(reload).toHaveBeenCalledTimes(2); // no third reload inside the TTL
  capped.unmount();

  // Past the TTL the stamp is discarded, so the next occurrence reloads again.
  vi.advanceTimersByTime(5 * 60_000);
  const afterTtl = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  expect(afterTtl.result.current.isReloading).toBe(true);
  vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(3);
});

it('lets a second boundary tripped by the same deploy join the pending reload', () => {
  // Two boundaries can catch in one commit. The second would otherwise read the
  // first's milliseconds-old stamp as a *previous* reload that failed, report a
  // fault that has not happened, and flash a crash card until the reload fires.
  const first = renderHook(() => useErrorBoundaryRecovery(skewError(), 'boundary-a'));
  expect(first.result.current.isReloading).toBe(true);

  const error = Object.assign(skewError(), { digest: 'same-commit' });
  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'boundary-b'));

  expect(result.current.isReloading).toBe(true);
  expect(logError).not.toHaveBeenCalled();

  vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('does not report its own pending reload as unrecovered skew when it re-renders', () => {
  // `setIsReloading` re-renders the boundary and `useClientLogger` hands back a
  // fresh object, so the effect re-runs while the reload is still pending. The
  // stamp it then reads is its own.
  const { result, rerender } = renderHook(() =>
    useErrorBoundaryRecovery(skewError(), 'a-boundary'),
  );

  rerender();
  rerender();

  expect(result.current.isReloading).toBe(true);
  expect(logError).not.toHaveBeenCalled();

  vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reports a given error once, however often the boundary re-renders', () => {
  // `useClientLogger` hands back a new object each render, so the effect's deps
  // change every time — the same fault must not be re-sent on each re-render.
  const error = Object.assign(new Error('ClickHouse unavailable'), { digest: 'abc123' });
  const { rerender } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  rerender();
  rerender();

  expect(logError).toHaveBeenCalledTimes(1);
});

it('keys the dedupe on the error, so a second distinct fault is still reported', () => {
  // The dedupe has to suppress repeats of ONE error, not silence the boundary
  // after its first report: a boundary handed a new error while mounted (a retry
  // that fails differently) owes a second report. Pinning the key here means the
  // suppression cannot be widened to "once per instance" unnoticed, which is the
  // shape that would swallow real faults.
  const first = Object.assign(new Error('ClickHouse unavailable'), { digest: 'first' });
  const second = Object.assign(new Error('Postgres unavailable'), { digest: 'second' });
  let error = first;
  const { rerender } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  error = second;
  rerender();

  expect(logError).toHaveBeenCalledTimes(2);
  expect(logError).toHaveBeenNthCalledWith(1, first, {
    digest: 'first',
    source: 'a-boundary',
  });
  expect(logError).toHaveBeenNthCalledWith(2, second, {
    digest: 'second',
    source: 'a-boundary',
  });
});

it('does not reload again for a chunk that fails long after the shell mounted, inside the TTL', () => {
  // The loop this closes: a successful mount is NOT evidence of a good deploy,
  // because chunk skew mounts the shell and only then fails on a lazy import().
  // Anything that restored the budget on a mount signal would let a broken
  // deploy cycle forever, since the mount always happens before the failure.
  const first = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  first.unmount();
  simulateReload();

  const second = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  second.unmount();
  simulateReload();
  expect(reload).toHaveBeenCalledTimes(2);
  logError.mockClear();

  // The shell comes up fine and the chunk 404s a minute later — still inside the
  // TTL, so the budget it spent is still charged against this incident.
  vi.advanceTimersByTime(60_000);
  const error = Object.assign(skewError(), { digest: 'late-chunk' });
  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  vi.advanceTimersByTime(30_000);
  expect(reload).toHaveBeenCalledTimes(2);
  expect(logError).toHaveBeenCalledWith(error, {
    digest: 'late-chunk',
    source: 'a-boundary',
    unrecoveredSkew: true,
    reloadableClass: 'deployment-skew',
    msSinceLastReload: 60_500,
    reloadAttempts: 2,
    // Sentry's beforeSend keys off this to keep the event at `error` instead of
    // filing it as a self-healed warning.
    automaticRecovery: 'exhausted',
  });
});

it('gives a full budget to a deploy met past the TTL, so a long session is not stranded', () => {
  // The other direction of the same boundary: a spent budget must not follow the
  // user for the rest of the session. A genuinely separate deploy, later, is a
  // new incident and gets its own reloads.
  const first = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  first.unmount();
  simulateReload();

  const second = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  second.unmount();
  simulateReload();
  expect(reload).toHaveBeenCalledTimes(2);
  logError.mockClear();

  vi.advanceTimersByTime(5 * 60_000); // the incident's stamp outlives its TTL

  const { result } = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));

  expect(result.current.isReloading).toBe(true);
  expect(logError).not.toHaveBeenCalled();
  vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(3);
});

it('does not call an unrecovered RSC stream close a deployment skew', () => {
  // "Connection closed." comes from an aborted Flight stream — a network hiccup
  // or a navigation that cut it off — so a reload fixes it, but no deploy need
  // have happened. Asserting skew here invents broken deploys out of ordinary
  // transport noise, in the exact signal that exists to detect the real ones.
  const streamClose = () => new Error('Connection closed.');
  const first = renderHook(() => useErrorBoundaryRecovery(streamClose(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  first.unmount();
  simulateReload();

  const second = renderHook(() => useErrorBoundaryRecovery(streamClose(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  second.unmount();
  simulateReload();
  logError.mockClear();

  const error = Object.assign(streamClose(), { digest: 'stream-3' });
  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  expect(logError).toHaveBeenCalledWith(error, {
    digest: 'stream-3',
    source: 'a-boundary',
    unrecoveredSkew: false,
    reloadableClass: 'rsc-stream-closed',
    msSinceLastReload: 500,
    reloadAttempts: 2,
    // Sentry's beforeSend keys off this to keep the event at `error` instead of
    // filing it as a self-healed warning.
    automaticRecovery: 'exhausted',
  });
});

it('asks for a refresh once the reloads are spent, under its own reason', () => {
  // This is the branch where the stale bundle is PROVEN — reloads ran and the
  // same chunk is still missing — so `reset()` is the one action that cannot
  // help. It re-renders against that same bundle, and each press throws a fresh
  // Error whose new identity defeats the report dedupe, sending another report
  // per click. The reason is distinct from the unverifiable-guard case because
  // that one has not reloaded at all, and telling this user "a new version was
  // released" points them at a fix that already failed.
  const first = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  first.unmount();
  simulateReload();

  const second = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));
  vi.advanceTimersByTime(500);
  second.unmount();
  simulateReload();

  const { result } = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  expect(result.current.needsManualRefresh).toBe(true);
  expect(result.current.manualRefreshReason).toBe('reloads-spent');
});

it('shows and reports the error when the guard cannot be READ', () => {
  // A storage-partitioned context throws on access. Throwing from inside the
  // effect would take down the error boundary itself, and without the guard a
  // reload loop is unbounded — so this must fail toward showing the error, and
  // must still report it rather than swallowing the fault.
  const error = Object.assign(skewError(), { digest: 'part-1' });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });

  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  // No reload has been attempted, so this is the "may be stale" prompt rather
  // than the one that admits reloading already failed.
  expect(result.current.manualRefreshReason).toBe('guard-unverifiable');
  vi.advanceTimersByTime(500);
  expect(reload).not.toHaveBeenCalled();
  // Not `unrecoveredSkew` — this may be the user's first skew error, and
  // labelling it as a survived reload would poison that signal. `guardFailure`
  // separates the user's browser config from our own code exhausting the quota,
  // which are different bugs owned by different people.
  expect(logError).toHaveBeenCalledWith(error, {
    digest: 'part-1',
    source: 'a-boundary',
    reloadGuardUnverifiable: true,
    guardFailure: 'read',
    automaticRecovery: 'unverifiable',
  });
});

it('refuses to reload when the guard cannot be WRITTEN, so a lost stamp cannot loop', () => {
  // Readable but not writable — quota exhausted by other same-origin code, or a
  // webview whose writes go nowhere. A dropped stamp means the next page reads
  // no stamp, reloads again, and loops forever: no in-memory state survives a
  // reload to bound it. The bounded failure is to show the error instead.
  const error = Object.assign(skewError(), { digest: 'quota-1' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });

  const { result } = renderHook(() => useErrorBoundaryRecovery(error, 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  expect(result.current.manualRefreshReason).toBe('guard-unverifiable');
  vi.advanceTimersByTime(500);
  expect(reload).not.toHaveBeenCalled();
  // `write` rather than `read`: the storage answered, our own write is what
  // failed. Swapping the two would point triage at the wrong owner.
  expect(logError).toHaveBeenCalledWith(error, {
    digest: 'quota-1',
    source: 'a-boundary',
    reloadGuardUnverifiable: true,
    guardFailure: 'write',
    automaticRecovery: 'unverifiable',
  });
});

it('refuses to reload when a write neither throws nor persists', () => {
  // The silent variant: `setItem` succeeds and the value is not there.
  // Nothing throws, so only reading the stamp back catches it.
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});

  const { result } = renderHook(() => useErrorBoundaryRecovery(skewError(), 'a-boundary'));

  expect(result.current.isReloading).toBe(false);
  expect(result.current.manualRefreshReason).toBe('guard-unverifiable');
  vi.advanceTimersByTime(500);
  expect(reload).not.toHaveBeenCalled();
});

it('leaves a genuine fault free of the manual-refresh prompt', () => {
  // Refreshing does nothing for a backend failure, and telling the user the page
  // is out of date when it is not sends them chasing the wrong thing.
  const { result } = renderHook(() =>
    useErrorBoundaryRecovery(new Error('ClickHouse unavailable'), 'a-boundary'),
  );

  expect(result.current.needsManualRefresh).toBe(false);
  expect(result.current.manualRefreshReason).toBe(null);
});
