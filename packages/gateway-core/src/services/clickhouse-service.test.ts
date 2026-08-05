/**
 * Unit tests for ClickHouseService.
 *
 * Bug classes covered:
 *   - Empty-rows guard: `insertTraces([])` must NOT call the underlying
 *     client. Removing the guard would issue an empty insert and the
 *     ClickHouse client raises on that.
 *   - Async-insert durability settings: `async_insert: 1` paired with
 *     `wait_for_async_insert: 1` is the contract for queue-based
 *     ingestion (ack only after persistence). A refactor that dropped
 *     either flag breaks at-least-once delivery.
 *   - Deduplication-token plumbing: when provided, it must land in
 *     `clickhouse_settings.insert_deduplication_token`; when omitted,
 *     that key must NOT be set (the client treats `undefined` as a
 *     valid distinct token in some versions).
 *   - Query passthrough: query string, `query_params`, and format
 *     reach the client unchanged. Catches a refactor that hardcoded
 *     the format or shuffled the parameter object.
 *   - Factory wires the constructor correctly (createClient called
 *     with the host + password from config).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ClickHouseService,
  createClickHouseService,
  CLICKHOUSE_REQUEST_TIMEOUT_MS,
  type ClickHouseServiceConfig,
} from './clickhouse-service';
import type { ClickHouseRow } from './span-converter';

// Capture the args passed to `createClient` so we can assert the
// factory wired host/password correctly.
const createClientCalls: Array<Record<string, unknown>> = [];

const insertMock = vi.fn().mockResolvedValue(undefined);
const queryMock = vi.fn();

vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn((opts: Record<string, unknown>) => {
    createClientCalls.push(opts);
    return {
      insert: insertMock,
      query: queryMock,
    };
  }),
}));

const config: ClickHouseServiceConfig = {
  host: 'https://clickhouse.example/123',
  password: 'secret-pw',
};

const sampleRow: ClickHouseRow = {
  TraceId: 'trace-1',
  SpanId: 'span-1',
} as unknown as ClickHouseRow;

beforeEach(() => {
  insertMock.mockClear();
  queryMock.mockReset();
  createClientCalls.length = 0;
});

describe('ClickHouseService.insertTraces', () => {
  it('empty rows: returns without calling the underlying client', async () => {
    const service = new ClickHouseService(config);

    await service.insertTraces([]);

    expect(insertMock).not.toHaveBeenCalled();
  });

  it('non-empty rows: inserts into otel_traces with JSONEachRow format and async-insert durability settings', async () => {
    const service = new ClickHouseService(config);
    const rows = [sampleRow, sampleRow];

    await service.insertTraces(rows);

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith({
      table: 'otel_traces',
      values: rows,
      format: 'JSONEachRow',
      // Both flags MUST be present — `wait_for_async_insert: 1`
      // alone or `async_insert: 1` alone breaks the at-least-once
      // delivery contract.
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
  });

  it('with deduplicationToken: token lands in clickhouse_settings.insert_deduplication_token', async () => {
    const service = new ClickHouseService(config);

    await service.insertTraces([sampleRow], { deduplicationToken: 'sha256-abc' });

    const callArg = insertMock.mock.calls[0]![0] as {
      clickhouse_settings: Record<string, unknown>;
    };
    expect(callArg.clickhouse_settings.insert_deduplication_token).toBe('sha256-abc');
    // Other durability flags must still be present alongside the token.
    expect(callArg.clickhouse_settings.async_insert).toBe(1);
    expect(callArg.clickhouse_settings.wait_for_async_insert).toBe(1);
  });

  it('without deduplicationToken: insert_deduplication_token key is NOT set in settings (exercises both no-options and undefined-token paths)', async () => {
    // ClickHouse's client treats `undefined` as a valid distinct token
    // value in some versions, so the production code only adds the
    // key when a real token was passed. A refactor that always
    // assigned `clickhouse_settings.insert_deduplication_token =
    // options?.deduplicationToken` would break dedup for the
    // no-token call path. Both code paths (no options object AND
    // options with undefined token) must satisfy this contract.
    const service = new ClickHouseService(config);

    // Path 1: no options arg.
    await service.insertTraces([sampleRow]);
    const noOptsArg = insertMock.mock.calls[0]![0] as {
      clickhouse_settings: Record<string, unknown>;
    };
    expect('insert_deduplication_token' in noOptsArg.clickhouse_settings).toBe(false);

    // Path 2: options arg with undefined token.
    insertMock.mockClear();
    await service.insertTraces([sampleRow], { deduplicationToken: undefined });
    const undefTokenArg = insertMock.mock.calls[0]![0] as {
      clickhouse_settings: Record<string, unknown>;
    };
    expect('insert_deduplication_token' in undefTokenArg.clickhouse_settings).toBe(false);
  });
});

describe('ClickHouseService.query', () => {
  it('passes query string and params through; deserializes the JSON response', async () => {
    interface Row {
      id: string;
      count: number;
    }
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ id: 'a', count: 5 } satisfies Row]),
    });

    const service = new ClickHouseService(config);
    const result = await service.query<Row>(
      'SELECT id, count FROM tbl WHERE x = {tenantId:String}',
      { tenantId: 't-1' },
    );

    // The result must be the parsed JSON, not the raw response object.
    expect(result).toEqual([{ id: 'a', count: 5 }]);

    // The query was issued with the exact arg shape the ClickHouse
    // client expects. Catches: parameter rename (query → sql),
    // missing format, params swallowed.
    expect(queryMock).toHaveBeenCalledWith({
      query: 'SELECT id, count FROM tbl WHERE x = {tenantId:String}',
      query_params: { tenantId: 't-1' },
      format: 'JSONEachRow',
    });
  });

});

describe('createClickHouseService factory', () => {
  it('wires host and password from config into the ClickHouse client, with a bounded request_timeout', () => {
    createClickHouseService({ host: 'https://ch.example', password: 'pw-xyz' });

    // The factory must pass host as `url` (not `host` — the client
    // renames it). A refactor that forgot the rename would fail
    // silently at construction.
    //
    // request_timeout MUST be set: leaving it unset reverts the client to
    // its 30s default, which lets a slow `wait_for_async_insert` insert hang
    // the queue consumer for 30s/attempt and balloon into multi-minute trace
    // lag. The exact value is pinned to the exported constant
    // so a silent regression to the default is caught here.
    expect(createClientCalls).toHaveLength(1);
    expect(createClientCalls[0]).toEqual({
      url: 'https://ch.example',
      password: 'pw-xyz',
      request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
    });
    expect(CLICKHOUSE_REQUEST_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('honors an explicit requestTimeoutMs override from config', () => {
    createClickHouseService({ host: 'https://ch.example', password: 'pw-xyz', requestTimeoutMs: 4_321 });

    expect(createClientCalls[0]).toEqual({
      url: 'https://ch.example',
      password: 'pw-xyz',
      request_timeout: 4_321,
    });
  });
});
