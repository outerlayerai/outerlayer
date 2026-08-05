/**
 * Storage Metering Handler — Integration Tests
 *
 * Real ClickHouse, mock Stripe. No Supabase needed — the handler
 * only does delta metering (cap enforcement is in StorageCapService).
 *
 * Verifies:
 * - ClickHouse query correctly sums raw bytes from String + Map columns
 * - length(toString(MapColumn)) returns real byte size, not key count
 * - Fractional GB values are calculated correctly from byte totals
 * - 60-second time window filtering works
 * - Multiple customers get separate Stripe events
 */

import { describe, it, expect, vi } from 'vitest';
import { createClient as createClickHouseClient } from '@clickhouse/client-web';
import {
  CLICKHOUSE_TEST_HOST,
  executeClickHouse,
} from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import {
  storageMeteringHandler,
  type IStripeClient,
  type StorageMeteringDeps,
} from '../../../../gateway/src/jobs/storage-metering-handler';
import type { GatewayScheduleContext } from '@repo/gateway-core/types';
import { asStorageMeteringClickHouseClient } from '../helpers/clickhouse-adapters';

// Only mock the logger
vi.mock('../../../../gateway/src/services/logger', () => ({
  createLoggerFromContext: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

const TEST_RUN_ID = Date.now().toString(36);

const JOB_TIME = Math.floor(Date.now() / 1000) - 300;
const SCHEDULED_TIME_MS = JOB_TIME * 1000;
const DATA_CREATED_AT = JOB_TIME - 30;

function customerId(suffix: string) {
  return `cus_storage_${TEST_RUN_ID}_${suffix}`;
}

function tenantId(suffix: string) {
  return `tenant_storage_${TEST_RUN_ID}_${suffix}`;
}

function appId(suffix: string) {
  return `app_storage_${TEST_RUN_ID}_${suffix}`;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

function createContext(scheduledTime: number = SCHEDULED_TIME_MS): GatewayScheduleContext {
  return {
    env: {
      CLICKHOUSE_HOST: CLICKHOUSE_TEST_HOST,
      CLICKHOUSE_PASSWORD: '',
      STRIPE_SECRET_KEY: 'sk_test_integration',
      STRIPE_STORAGE_METER_KEY: 'storage_gb_meter',
    } as any,
    ctx: { waitUntil: vi.fn() },
    event: { cron: '* * * * *', scheduledTime, noRetry: vi.fn() as any },
    cache: {} as any,
  };
}

function createMockStripe() {
  const meterEventsCreate = vi.fn().mockResolvedValue({ id: 'meter_event_123' });
  const stripe: IStripeClient & { meterEventsCreate: typeof meterEventsCreate } = {
    billing: { meterEvents: { create: meterEventsCreate } },
    meterEventsCreate,
  };
  return stripe;
}

function createDeps(stripe: ReturnType<typeof createMockStripe>): StorageMeteringDeps {
  return {
    clickhouse: asStorageMeteringClickHouseClient(
      createClickHouseClient({ url: CLICKHOUSE_TEST_HOST, password: '' }) as any,
    ),
    stripe,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertSpansWithPayload(params: {
  stripeCustomerId: string;
  tenant: string;
  app: string;
  input?: string;
  output?: string;
  spanAttributes?: Record<string, string>;
  createdAt?: number;
  count?: number;
}) {
  const {
    stripeCustomerId, tenant, app,
    input = '', output = '',
    spanAttributes = {},
    createdAt = DATA_CREATED_AT,
    count = 1,
  } = params;

  const esc = (s: string) => s.replace(/'/g, "\\'");
  const formatMap = (m: Record<string, string>) => {
    const entries = Object.entries(m).flatMap(([k, v]) => [`'${esc(k)}'`, `'${esc(v)}'`]);
    return entries.length > 0 ? `map(${entries.join(',')})` : `map()`;
  };

  const values = Array.from({ length: count }, () => {
    const tid = `trace-${TEST_RUN_ID}-${crypto.randomUUID()}`;
    const sid = `span-${TEST_RUN_ID}-${crypto.randomUUID()}`;
    return `(now64(9), toDateTime(${createdAt}), '${tid}', '${sid}', '${tenant}', '${app}', '${stripeCustomerId}', 'test-span', '${esc(input)}', '${esc(output)}', ${formatMap(spanAttributes)}, map(), map(), now64(3), 0)`;
  });

  await executeClickHouse(
    `INSERT INTO otel_traces (Timestamp, CreatedAt, TraceId, SpanId, TenantId, AppId, StripeCustomerId, SpanName, Input, Output, SpanAttributes, ResourceAttributes, Metadata, UpdatedAt, IsDeleted)
     VALUES ${values.join(', ')}`
  );
}

function getMeterEventPayloads(stripe: ReturnType<typeof createMockStripe>) {
  return stripe.meterEventsCreate.mock.calls.map((call: any[]) => ({
    eventName: call[0].event_name,
    value: call[0].payload.value,
    customerId: call[0].payload.stripe_customer_id,
    idempotencyKey: call[1].idempotencyKey,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Storage Metering Handler — Integration', () => {
  describe('byte counting from ClickHouse', () => {
    it('should measure bytes from Input and Output String columns', async () => {
      const cid = customerId('strings');
      const input = 'A'.repeat(100);
      const output = 'B'.repeat(200);

      await insertSpansWithPayload({ stripeCustomerId: cid, tenant: tenantId('strings'), app: appId('strings'), input, output });
      await flushAndWaitForClickHouse(
        `SELECT COUNT(*) as c FROM otel_traces WHERE StripeCustomerId = '${cid}' AND CreatedAt >= ${JOB_TIME - 60} AND CreatedAt < ${JOB_TIME}`,
        (r) => r.length > 0 && Number(r[0].c) >= 1,
      );

      const stripe = createMockStripe();
      await storageMeteringHandler(createContext(), createDeps(stripe));

      const p = getMeterEventPayloads(stripe).find((p) => p.customerId === cid);
      expect(p).toBeDefined();
      const gb = Number(p!.value);
      expect(gb).toBeGreaterThanOrEqual(300 / 1_000_000_000);
      expect(gb).toBeLessThan(1000 / 1_000_000_000);
    });

    it('should measure bytes from Map columns using toString()', async () => {
      const cid = customerId('maps');
      await insertSpansWithPayload({
        stripeCustomerId: cid, tenant: tenantId('maps'), app: appId('maps'),
        spanAttributes: { model: 'gpt-4', prompt_template: 'X'.repeat(500) },
      });
      await flushAndWaitForClickHouse(
        `SELECT COUNT(*) as c FROM otel_traces WHERE StripeCustomerId = '${cid}' AND CreatedAt >= ${JOB_TIME - 60}`,
        (r) => r.length > 0 && Number(r[0].c) >= 1,
      );

      const stripe = createMockStripe();
      await storageMeteringHandler(createContext(), createDeps(stripe));

      const p = getMeterEventPayloads(stripe).find((p) => p.customerId === cid);
      expect(p).toBeDefined();
      expect(Number(p!.value)).toBeGreaterThan(500 / 1_000_000_000);
    });

    it('should sum bytes across multiple spans', async () => {
      const cid = customerId('multi');
      await insertSpansWithPayload({
        stripeCustomerId: cid, tenant: tenantId('multi'), app: appId('multi'),
        input: 'X'.repeat(1000), count: 3,
      });
      await flushAndWaitForClickHouse(
        `SELECT COUNT(*) as c FROM otel_traces WHERE StripeCustomerId = '${cid}' AND CreatedAt >= ${JOB_TIME - 60}`,
        (r) => r.length > 0 && Number(r[0].c) >= 3,
      );

      const stripe = createMockStripe();
      await storageMeteringHandler(createContext(), createDeps(stripe));

      const p = getMeterEventPayloads(stripe).find((p) => p.customerId === cid);
      expect(p).toBeDefined();
      expect(Number(p!.value)).toBeGreaterThanOrEqual(3000 / 1_000_000_000);
    });
  });

  describe('time window filtering', () => {
    it('should only count data within the 60-second window', async () => {
      const cid = customerId('window');
      await insertSpansWithPayload({
        stripeCustomerId: cid, tenant: tenantId('window'), app: appId('window'),
        input: 'INSIDE'.repeat(100), createdAt: DATA_CREATED_AT,
      });
      await insertSpansWithPayload({
        stripeCustomerId: cid, tenant: tenantId('window'), app: appId('window'),
        input: 'OUTSIDE'.repeat(10000), createdAt: JOB_TIME - 180,
      });
      await flushAndWaitForClickHouse(
        `SELECT COUNT(*) as c FROM otel_traces WHERE StripeCustomerId = '${cid}'`,
        (r) => r.length > 0 && Number(r[0].c) >= 2,
      );

      const stripe = createMockStripe();
      await storageMeteringHandler(createContext(), createDeps(stripe));

      const p = getMeterEventPayloads(stripe).find((p) => p.customerId === cid);
      expect(p).toBeDefined();
      const gb = Number(p!.value);
      expect(gb).toBeLessThan('OUTSIDE'.repeat(10000).length / 1_000_000_000);
      expect(gb).toBeGreaterThanOrEqual('INSIDE'.repeat(100).length / 1_000_000_000);
    });
  });

  describe('multiple customers', () => {
    it('should send separate Stripe events per customer', async () => {
      const cid1 = customerId('cust1');
      const cid2 = customerId('cust2');

      await insertSpansWithPayload({ stripeCustomerId: cid1, tenant: tenantId('cust1'), app: appId('cust1'), input: 'A'.repeat(500) });
      await insertSpansWithPayload({ stripeCustomerId: cid2, tenant: tenantId('cust2'), app: appId('cust2'), input: 'B'.repeat(1000) });
      await flushAndWaitForClickHouse(
        `SELECT COUNT(*) as c FROM otel_traces WHERE StripeCustomerId IN ('${cid1}', '${cid2}') AND CreatedAt >= ${JOB_TIME - 60}`,
        (r) => r.length > 0 && Number(r[0].c) >= 2,
      );

      const stripe = createMockStripe();
      await storageMeteringHandler(createContext(), createDeps(stripe));

      const payloads = getMeterEventPayloads(stripe);
      expect(payloads.find((p) => p.customerId === cid1)).toBeDefined();
      expect(payloads.find((p) => p.customerId === cid2)).toBeDefined();
      expect(Number(payloads.find((p) => p.customerId === cid2)!.value))
        .toBeGreaterThan(Number(payloads.find((p) => p.customerId === cid1)!.value));
    });
  });

  describe('fractional GB precision', () => {
    it('should preserve sub-KB precision in Stripe event value', async () => {
      const cid = customerId('precision');
      await insertSpansWithPayload({ stripeCustomerId: cid, tenant: tenantId('precision'), app: appId('precision'), input: 'tiny' });
      await flushAndWaitForClickHouse(
        `SELECT COUNT(*) as c FROM otel_traces WHERE StripeCustomerId = '${cid}' AND CreatedAt >= ${JOB_TIME - 60}`,
        (r) => r.length > 0 && Number(r[0].c) >= 1,
      );

      const stripe = createMockStripe();
      await storageMeteringHandler(createContext(), createDeps(stripe));

      const p = getMeterEventPayloads(stripe).find((p) => p.customerId === cid);
      expect(p).toBeDefined();
      const gb = Number(p!.value);
      expect(gb).toBeGreaterThan(0);
      expect(gb).toBeLessThan(0.001);
    });
  });
});
