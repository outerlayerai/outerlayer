/**
 * OpenAPI response-schema conformance tests.
 *
 * Validates that a *live* gateway response payload conforms to the OpenAPI
 * response schema the route declares — status code, content-type, AND body
 * shape/types — for the drift-prone read endpoints:
 *   GET /v1/spans, /v1/scores, /v1/api-keys
 *
 * Why this exists (the gap it closes):
 *   - packages/gateway-core/src/openapi/__tests__/route-handlers.test.ts already
 *     `safeParse`s responses against these schemas — but on MOCKED service
 *     data that is already ISO-shaped. The mock masks impl↔spec drift.
 *   - `/v1/spans` once shipped span timestamps as epoch-ms while the schema
 *     declared `z.string().datetime()` (ISO-8601). Every existing test
 *     passed; it was caught by hand.
 *
 * How it stays honest:
 *   - The schemas are the EXACT `*ResponseSchema` objects each route registers
 *     in its OpenAPI `responses` (imported from `@repo/api-schemas`),
 *     so "conforms to the imported schema" == "conforms to the declared
 *     OpenAPI response schema". Nothing is hand-copied.
 *   - It seeds deterministic rows into the same local Supabase + ClickHouse the
 *     gateway reads (no STG, no LLM, fixed inputs) and asserts on shape/type,
 *     never on generated text — so it is CI-gating and reproducible.
 *
 * Mirrors the seeding/teardown pattern in traces.test.ts + spans.test.ts:
 * unique RUN_ID prefix, root-span rows in otel_traces, ALTER TABLE … DELETE
 * cleanup, and flushAndWaitForClickHouse to absorb async-insert + RMT lag.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SpansListResponseSchema,
  ScoresListResponseSchema,
  ScoreDetailResponseSchema,
  ApiKeysListResponseSchema,
} from '@repo/api-schemas';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';

// ---------------------------------------------------------------------------
// Identifiers + constants
// ---------------------------------------------------------------------------

const RUN_ID = `conf-${Date.now().toString(36)}`;

const TRACE_ID = `${RUN_ID}-trace`;
const SESSION_ID = `${RUN_ID}-sess`;
const ROOT_SPAN = `${RUN_ID}-span-root`;
const CHILD_SPAN = `${RUN_ID}-span-child`;

const SCORE_ID = randomUUID();
const SCORE_NAME = `${RUN_ID}-accuracy`;

// ISO-8601 UTC with a `Z` zone and optional fractional seconds — the exact
// shape `z.string().datetime()` accepts. Used for the explicit timestamp
// regression assertions that pin the epoch-ms / zoneless-CH drift fixes.
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Local-only Supabase service-role key — the same demo key hardcoded in
// apps/gateway/scripts/seed-test-tenant.ts and setup-gateway.ts. Used to seed +
// clean rows (api_key) directly (bypasses RLS) since there is no
// public write endpoint for them.
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// ---------------------------------------------------------------------------
// Conformance assertion
// ---------------------------------------------------------------------------

/**
 * Structural view of a zod schema's `safeParse`. The response schemas come from
 * `@repo/api-schemas`, which bundles its own zod instance; typing the
 * param as that package's `z.ZodTypeAny` would couple this file to that exact
 * instance. A structural type accepts any zod-shaped schema regardless of
 * version and keeps the failure formatter happy.
 */
interface ConformanceSchema {
  safeParse(data: unknown):
    | { success: true }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
      };
}

/**
 * Run a schema's `safeParse` and format any zod issues as `path: message`
 * lines. Typing `schema` structurally (rather than as a specific zod instance)
 * keeps the `.map` callback's `i` properly typed regardless of which zod
 * version produced the schema — and lets both the envelope check and the
 * per-row CRUD-follow-up checks share one formatter.
 */
function checkSchema(
  schema: ConformanceSchema,
  value: unknown,
): { ok: boolean; issues: string } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, issues: '' };
  return {
    ok: false,
    issues: parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n'),
  };
}

/**
 * Assert a live gateway Response conforms to its declared OpenAPI response
 * schema: HTTP 200, JSON content-type, and a body that passes `schema`. On a
 * schema miss, surface every zod issue (path + message) plus a truncated body
 * so the failure names the exact field that drifted — not just
 * "safeParse returned false". Returns the parsed body for follow-up assertions.
 */
async function assertConforms(
  res: Response,
  schema: ConformanceSchema,
  label: string,
): Promise<unknown> {
  expect(res.status, `${label}: expected HTTP 200`).toBe(200);

  const contentType = res.headers.get('content-type') ?? '';
  expect(
    contentType.includes('application/json'),
    `${label}: expected application/json content-type, got "${contentType}"`,
  ).toBe(true);

  const body = await res.json();
  const { ok, issues } = checkSchema(schema, body);
  expect(
    ok,
    `${label}: live response body violates its OpenAPI response schema:\n${issues}\n` +
      `received: ${JSON.stringify(body).slice(0, 1500)}`,
  ).toBe(true);

  return body;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function chDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// 30 minutes ago — comfortably inside the default lookback window spans.test.ts
// relies on for its own seeded rows.
const SEED_AT = new Date(Date.now() - 30 * 60 * 1000);

/**
 * One trace with a root + child span. Seeds the rows GET /v1/spans
 * (2 span rows, via ?trace_id) and GET /v1/scores (via the trace's id)
 * conform-test against.
 */
async function seedTrace(appId: string, tenantId: string): Promise<void> {
  const ts = chDate(SEED_AT);
  const endTs = chDate(new Date(SEED_AT.getTime() + 1200));
  const rows = [
    // Root span (ParentSpanId='') — drives TraceName/status rollup.
    `('${ts}','${TRACE_ID}','${ROOT_SPAN}','','chat',
      '1','GENERATION','gpt-4o',1200,40,60,100,0.02,
      '${tenantId}','${appId}',
      '${SESSION_ID}','','user-${RUN_ID}','conf-trace',
      '','[]',
      '${endTs}','hello','world',
      now64(3),0)`,
    // Child span.
    `('${ts}','${TRACE_ID}','${CHILD_SPAN}','${ROOT_SPAN}','retrieval',
      '1','SPAN','',300,0,0,0,0,
      '${tenantId}','${appId}',
      '${SESSION_ID}','','user-${RUN_ID}','conf-trace',
      '','[]',
      '${endTs}','q','a',
      now64(3),0)`,
  ];
  await executeClickHouse(`
    INSERT INTO otel_traces (
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      StatusCode, Type, Model, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
      TenantId, AppId,
      SessionId, SessionName, UserId, TraceName,
      CommitSha, Tags,
      EndTime, Input, Output,
      UpdatedAt, IsDeleted
    ) VALUES ${rows.join(',')}
  `);
}

/** One score row referencing the seeded trace, for GET /v1/scores. */
async function seedScore(appId: string, tenantId: string): Promise<void> {
  await executeClickHouse(`
    INSERT INTO scores (
      Id, TenantId, AppId, ResourceId, Score, Label, Reason, Name,
      Type, DataType, Source, Environment, EnvironmentVersion, CommitSha,
      CreatedAt, UpdatedAt, IsDeleted
    ) VALUES (
      '${SCORE_ID}','${tenantId}','${appId}','${TRACE_ID}',0.9,'good','correct','${SCORE_NAME}',
      '','','eval','',0,'',
      now64(3), now64(3), 0
    )
  `);
}

/**
 * Generic Supabase REST helpers. Every CRUD-follow-up suite below seeds one
 * row, expects a single representation back, and cleans up by id. Centralizing
 * the request/response shape keeps the per-table helpers focused on the column
 * choices that matter for the conformance assertion.
 */
async function supabaseInsert(
  table: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${table} seed failed: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (rows.length !== 1 || !row) {
    throw new Error(`${table} seed returned ${rows.length} rows`);
  }
  return row;
}

async function supabaseDelete(table: string, id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
}

/**
 * Read the seeded app's default environment id. The api-key seed needs
 * `environment_id` (NOT NULL post-feature-054) and the test rig only knows
 * the app id, so we look the env up here. The seed script in
 * `apps/gateway/scripts/seed-test-tenant.ts` guarantees exactly one default
 * `dev` env per seeded app — we read by `app_id` + `is_default=true`.
 */
async function getDefaultEnvironmentId(appId: string): Promise<string> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/environment?app_id=eq.${appId}&is_default=eq.true&select=id&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`environment lookup failed: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as Array<{ id: string }>;
  if (rows.length !== 1 || !rows[0]?.id) {
    throw new Error(`environment lookup returned ${rows.length} rows for app ${appId}`);
  }
  return rows[0].id;
}

/**
 * Seed one `api_key` row. `environment_id` is NOT NULL post-feature-054, so we
 * bind to the test app's default env (the gateway seed script guarantees one).
 * `api_key_id` (the Unkey keyId column) is `UNIQUE`, so prefix it with RUN_ID
 * to keep concurrent runs collision-free.
 */
async function seedApiKey(
  appId: string,
  tenantId: string,
  environmentId: string,
): Promise<string> {
  const row = await supabaseInsert('api_key', {
    tenant_id: tenantId,
    app_id: appId,
    environment_id: environmentId,
    name: `conf-key-${RUN_ID}`,
    api_key_id: `key_${RUN_ID}`,
  });
  if (typeof row.id !== 'string') {
    throw new Error('api_key seed returned a row without a string id');
  }
  return row.id;
}

async function deleteApiKey(id: string): Promise<void> {
  await supabaseDelete('api_key', id);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OpenAPI response-schema conformance', () => {
  let appId: string;
  let tenantId: string;
  let apiKeyRowId: string;

  beforeAll(async () => {
    appId = getTestAppId();
    tenantId = getTestTenantId();

    await seedTrace(appId, tenantId);
    await seedScore(appId, tenantId);
    // Look up the app's default environment up front — satisfies the
    // post-feature-054 NOT NULL constraint on `api_key.environment_id` for
    // the api_key seed below.
    const environmentId = await getDefaultEnvironmentId(appId);
    apiKeyRowId = await seedApiKey(appId, tenantId, environmentId);

    // otel_traces: 2 span rows for the trace (root + child).
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE AppId = '${appId}' AND TraceId LIKE '${RUN_ID}-%' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
    // scores: the single seeded row.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM scores WHERE Id = '${SCORE_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(
      `ALTER TABLE otel_traces DELETE WHERE TraceId LIKE '${RUN_ID}-%'`,
    );
    await executeClickHouse(`ALTER TABLE scores DELETE WHERE Id = '${SCORE_ID}'`);
    if (apiKeyRowId) await deleteApiKey(apiKeyRowId);
  });

  it('GET /v1/spans conforms to SpansListResponseSchema', async () => {
    const res = await gatewayFetch(`/v1/spans?trace_id=${TRACE_ID}&limit=100`);
    const body = (await assertConforms(res, SpansListResponseSchema, 'GET /v1/spans')) as {
      data: Array<{ id: string; timestamp: string }>;
    };

    const seeded = body.data.filter((s) => s.id === ROOT_SPAN || s.id === CHILD_SPAN);
    expect(seeded.length, 'seeded spans not returned by /v1/spans').toBe(2);
    // Pins the /v1/spans timestamp fix (zoneless CH datetime → ISO-8601).
    for (const span of seeded) {
      expect(span.timestamp, `span ${span.id} timestamp not ISO-8601: ${span.timestamp}`).toMatch(
        ISO_8601_UTC,
      );
    }
  });


  it('GET /v1/scores conforms to ScoresListResponseSchema', async () => {
    const res = await gatewayFetch(
      `/v1/scores?name=${SCORE_NAME}&start_date=${dateOnly(-2)}&end_date=${dateOnly(1)}&limit=50`,
    );
    const body = (await assertConforms(res, ScoresListResponseSchema, 'GET /v1/scores')) as {
      data: Array<{ id: string; created_at: string }>;
    };

    const score = body.data.find((s) => s.id === SCORE_ID);
    expect(score, 'seeded score not returned by /v1/scores').toBeDefined();
    // created_at is z.string().datetime(); the service normalizes the CH value.
    expect(score!.created_at, `created_at not ISO-8601: ${score!.created_at}`).toMatch(
      ISO_8601_UTC,
    );
  });


  it('GET /v1/scores/{id} conforms to ScoreDetailResponseSchema', async () => {
    const res = await gatewayFetch(`/v1/scores/${SCORE_ID}`);
    const body = (await assertConforms(res, ScoreDetailResponseSchema, 'GET /v1/scores/{id}')) as {
      data: { id: string; created_at: string };
    };
    expect(body.data.id).toBe(SCORE_ID);
    expect(body.data.created_at, `created_at not ISO-8601: ${body.data.created_at}`).toMatch(
      ISO_8601_UTC,
    );
  });

  // -------------------------------------------------------------------
  // CRUD follow-ups (audit gaps found in a prior pass). Each test seeds via
  // Supabase REST, GETs the gateway endpoint, and pins (a) the envelope
  // matches its declared OpenAPI schema and (b) the seeded row carries
  // an ISO-8601 timestamp.
  // -------------------------------------------------------------------

  it('GET /v1/api-keys conforms to ApiKeysListResponseSchema', async () => {
    const res = await gatewayFetch('/v1/api-keys?limit=100');
    const body = (await assertConforms(res, ApiKeysListResponseSchema, 'GET /v1/api-keys')) as {
      data: Array<{ id: string; created_at: string }>;
    };
    // `api_key.id` is the row UUID; the seed used the row id returned from
    // INSERT representation, which matches the route's `select('id, ...')`.
    const row = body.data.find((k) => k.id === apiKeyRowId);
    expect(row, 'seeded api_key not returned by /v1/api-keys').toBeDefined();
    // ApiKeySchema declares created_at as z.string().datetime(); pin the
    // PostgREST timestamptz → ISO-Z fix end-to-end.
    expect(row!.created_at, `api_key created_at not ISO-8601: ${row!.created_at}`).toMatch(
      ISO_8601_UTC,
    );
  });

});
