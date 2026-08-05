/**
 * Shared ClickHouse resilience — every client built by the factories retries
 * ONE transient failure on reads and carries spill-to-disk query settings, so
 * an undersized deployment (memory-ceiling stalls, merge bursts) degrades to
 * slow responses instead of 500ing whichever endpoint queried first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fake, createdConfigs } = vi.hoisted(() => ({
  fake: {
    query: vi.fn(),
    insert: vi.fn(),
    close: vi.fn(),
  },
  createdConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn((config: Record<string, unknown>) => {
    createdConfigs.push(config);
    return fake;
  }),
}));

vi.mock('../../../config-global.server', () => ({
  CLICKHOUSE_HOST: 'http://ch.test:8123',
  CLICKHOUSE_PASSWORD: 'writer-secret',
  CLICKHOUSE_READ_USER: undefined,
  CLICKHOUSE_READ_PASSWORD: undefined,
}));

import { createClickHouseClient, DEFAULT_QUERY_SETTINGS } from '../client';

const MEMORY_ERROR = new Error(
  'Code: 241. DB::Exception: (total) memory limit exceeded: would use 7.22 GiB',
);

beforeEach(() => {
  vi.clearAllMocks();
  createdConfigs.length = 0;
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withTransientRetry (via createClickHouseClient)', () => {
  it('retries a read ONCE on a transient failure and returns the second result', async () => {
    fake.query.mockRejectedValueOnce(MEMORY_ERROR).mockResolvedValueOnce({ ok: true });
    const client = createClickHouseClient()!;

    const pending = client.query({ query: 'SELECT 1' } as never);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ ok: true });
    expect(fake.query).toHaveBeenCalledTimes(2);
    // Both attempts carry the SAME request — nothing mutated between tries.
    expect(fake.query).toHaveBeenNthCalledWith(2, { query: 'SELECT 1' });
  });

  it('gives up after the single retry — no loop against a down server', async () => {
    fake.query.mockRejectedValue(MEMORY_ERROR);
    const client = createClickHouseClient()!;

    const result = client.query({ query: 'SELECT 1' } as never).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await result).toBe(MEMORY_ERROR);
    expect(fake.query).toHaveBeenCalledTimes(2);
  });

  it('fails fast on non-transient errors (query bugs are not retried)', async () => {
    const bugError = new Error("Code: 47. DB::Exception: Unknown identifier 'TraceCount'");
    fake.query.mockRejectedValue(bugError);
    const client = createClickHouseClient()!;

    await expect(client.query({ query: 'SELECT bogus' } as never)).rejects.toBe(bugError);
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it('never retries writes — a failed insert surfaces immediately', async () => {
    fake.insert.mockRejectedValue(MEMORY_ERROR);
    const client = createClickHouseClient()!;

    await expect(
      client.insert({ table: 't', values: [], format: 'JSONEachRow' } as never),
    ).rejects.toBe(MEMORY_ERROR);
    expect(fake.insert).toHaveBeenCalledTimes(1);
  });

  it('retries connection-level failures (dropped socket), not just server codes', async () => {
    fake.query
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ok: true });
    const client = createClickHouseClient()!;

    const pending = client.query({ query: 'SELECT 1' } as never);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ ok: true });
    expect(fake.query).toHaveBeenCalledTimes(2);
  });
});

describe('spill-to-disk query settings', () => {
  it('caps per-query memory and spills oversized aggregation state to disk', () => {
    createClickHouseClient();
    const settings = createdConfigs[0]!.clickhouse_settings as Record<string, unknown>;
    // The pair that turns "hit the memory cap → die" into "finish slowly":
    // spill thresholds must sit BELOW the per-query memory cap.
    expect(settings.max_bytes_before_external_group_by).toBe(500_000_000);
    expect(settings.max_bytes_before_external_sort).toBe(500_000_000);
    expect(settings.max_memory_usage).toBe(1_000_000_000);
    expect(DEFAULT_QUERY_SETTINGS.max_bytes_before_external_group_by).toBeLessThan(
      DEFAULT_QUERY_SETTINGS.max_memory_usage as number,
    );
  });
});
