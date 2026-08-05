/**
 * Entrypoint glue (src/index.ts): load local dotenv, hand off to runWorker, and
 * — critically — convert a fatal runner error into a non-zero exit so the Fly
 * machine's auto_destroy + the reaper can reconcile the run. Both worker-runner
 * and dotenv are mocked so nothing real spawns; process.exit is spied so a
 * failure path can't tear down the test runner.
 */

describe('index entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('dotenv');
    vi.doUnmock('../worker-runner.js');
  });

  it('loads both dotenv files and invokes runWorker exactly once, without exiting on success', async () => {
    const runWorker = vi.fn().mockResolvedValue(undefined);
    const config = vi.fn();
    vi.doMock('dotenv', () => ({ config }));
    vi.doMock('../worker-runner.js', () => ({ runWorker }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await import('../index.js');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(config).toHaveBeenNthCalledWith(1, { path: '.env.local' });
    expect(config).toHaveBeenNthCalledWith(2, { path: '.env' });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs the message and exits 1 when runWorker rejects', async () => {
    const runWorker = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('dotenv', () => ({ config: vi.fn() }));
    vi.doMock('../worker-runner.js', () => ({ runWorker }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('../index.js');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errSpy).toHaveBeenCalledWith('Fatal worker runner error:', 'boom');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs the raw value (not .message) and exits 1 when runWorker rejects with a non-Error', async () => {
    const runWorker = vi.fn().mockRejectedValue('plain-string-failure');
    vi.doMock('dotenv', () => ({ config: vi.fn() }));
    vi.doMock('../worker-runner.js', () => ({ runWorker }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('../index.js');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errSpy).toHaveBeenCalledWith('Fatal worker runner error:', 'plain-string-failure');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
