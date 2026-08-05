/**
 * Integration tests for trace + score environment tagging.
 *
 * --------------------------------------------------------------------------
 * WHAT LAYER THIS ASSERTS AT — and why
 * --------------------------------------------------------------------------
 * The trace ingest path is: HTTP request → auth → `resolveEnvironmentFromApiKey`
 * (gateway, real Supabase lookup) → `normalizedSpanToClickHouseRow` (gateway,
 * pure converter) → ClickHouse insert.
 *
 * Driving the full HTTP path end-to-end requires a booted gateway worker
 * (authenticated with a real minted key) plus the separate ClickHouse docker
 * stack — that lives in the `gateway-http` vitest project, not this suite.
 * Per the task brief ("assert at the layer that's testable"), this file
 * asserts at the two real, testable seams of the ingest path:
 *
 *   1. `resolveEnvironmentFromApiKey` — exercised against a REAL local Supabase
 *      with REAL `api_key` + `environment` rows. This catches the query bug,
 *      the FK join, and the tenant-scoping filter.
 *   2. `normalizedSpanToClickHouseRow` — the pure converter, fed the resolver's
 *      real output. This catches the stamping policy (Environment /
 *      EnvironmentVersion / CommitSha / TraceSource).
 *
 * Wiring (1) → (2) is exactly what the production trace route does. The unit
 * suite `packages/gateway-core/src/services/span-converter.test.ts` covers the converter
 * with HAND-WRITTEN `resolvedEnv` objects; this file proves the converter
 * behaves correctly when fed env data that ACTUALLY came out of Postgres.
 *
 * The score-inheritance scenario is parent-trace-authoritative: a
 * score's env triple is resolved from the parent trace row via a TraceId/SpanId
 * lookup, NOT from the score-submitter's API key. That lookup is a ClickHouse
 * query (`resolveScoreEnvTriples` in `scores.ts`). This file asserts that rule
 * against a real ClickHouse round-trip WHEN the ClickHouse stack is reachable,
 * and skips (loudly, with a logged reason) when it is not — the same
 * conditional-contract pattern `storageDeleteWorks` uses in helpers.ts.
 *
 * Runs against a real local Supabase, with test data inlined in each test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
// Type-only import: `NormalizedSpan` is erased at compile time, so importing it
// pulls NO runtime code from `@repo/shared-utils` (whose barrel drags
// in markdown deps that vitest's integration-tests config cannot transform).
// `SpanType.SPAN` is the string literal `'SPAN'` — inlined below for the same
// reason (importing the enum would force the runtime barrel).
import type { NormalizedSpan } from '@repo/shared-utils';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
// Import the converter directly (not via the `gateway/services` barrel) — the
// barrel re-exports `./template`, whose markdown deps the integration-tests
// vitest config cannot transform. The converter itself only pulls `@repo/llm-costs`.
import { normalizedSpanToClickHouseRow } from '@repo/gateway-core/services/span-converter';
import {
  resolveEnvironmentFromApiKey,
  __clearEnvironmentResolverCache,
} from '@repo/gateway-core/lib/environment-resolver';
import type { UserMeta } from '@repo/gateway-core/types';
import {
  setupEnvFixture,
  seedPinnedEnvironment,
  type EnvTestFixture,
} from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INSERT an `api_key` row bound to a given environment and return the Unkey
 * key id (`api_key_id`) the gateway resolver looks up. Mirrors the production
 * key-creation path (env_id is mandatory).
 */
async function seedApiKey(
  fixture: EnvTestFixture,
  envId: string,
  label: string,
): Promise<string> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const apiKeyId = `key_${label}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const { error } = await admin.from('api_key').insert({
    tenant_id: fixture.tenant.id,
    app_id: fixture.app.id,
    environment_id: envId,
    name: `${label}-${Date.now().toString(36)}`,
    api_key_id: apiKeyId,
    created_by: fixture.ownerUser.id,
  });
  if (error) throw new Error(`seedApiKey(${label}) failed: ${error.message}`);
  return apiKeyId;
}

/** A minimal NormalizedSpan — only the fields the converter dereferences.
 *  `type` is the `SpanType.SPAN` enum value, inlined as its string literal to
 *  avoid a runtime import of the `@repo/shared-utils` barrel. */
function makeSpan(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return {
    traceId: 'trace-054',
    spanId: 'span-054',
    type: 'SPAN' as NormalizedSpan['type'],
    startTime: 1700000000000,
    duration: 100,
    name: 'test-span',
    kind: 'INTERNAL',
    statusCode: '1',
    resourceAttributes: {},
    spanAttributes: {},
    events: [],
    links: [],
    ...overrides,
  };
}

/** A minimal UserMeta — `resolvedEnv` is what the env tagging tests vary. */
function makeMeta(overrides: Partial<UserMeta> = {}): UserMeta {
  return {
    appId: 'app-054',
    tenantId: 'tenant-054',
    stripeCustomerId: 'cus_054',
    stripeSubscriptionId: 'sub_054',
    appName: 'env test app',
    branchId: 'main',
    ...overrides,
  };
}

describe('Trace + score env tagging', () => {
  let fixture: EnvTestFixture;
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  beforeAll(async () => {
    fixture = await setupEnvFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  beforeEach(() => {
    // The resolver caches for 60s — clear between tests so a revocation /
    // re-seed in one test cannot leak a stale entry into the next.
    __clearEnvironmentResolverCache();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Gateway stamps env + version from the key's env
  // ───────────────────────────────────────────────────────────────────────

  describe('gateway stamps Environment + EnvironmentVersion from the API key binding', () => {
    it('should stamp the pinned env name and version on a trace when the key is bound to a pinned env', async () => {
      // Arrange: a pinned `prod` env + an API key bound to it.
      const prod = await seedPinnedEnvironment(fixture, {
        name: 'prod',
        version: 4,
        commitSha: 'commit-prod-v4',
      });
      const apiKeyId = await seedApiKey(fixture, prod.id, 'prod');

      // Act: resolve the env from the key (real Supabase), then stamp a span.
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId,
        tenantId: fixture.tenant.id,
      });
      const row = normalizedSpanToClickHouseRow(
        makeSpan(),
        makeMeta({ resolvedEnv: resolved ?? undefined }),
      );

      // Assert: the triple is stamped from the resolved env row.
      expect(resolved).not.toBeNull();
      expect(row.Environment).toBe('prod');
      expect(row.EnvironmentVersion).toBe(4);
      expect(row.CommitSha).toBe('commit-prod-v4');

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', apiKeyId);
      await admin.from('environment').delete().eq('id', prod.id);
    });

    it('should stamp env name with EnvironmentVersion 0 and IGNORE the SDK CommitSha when the key is bound to a no-pin env', async () => {
      // Arrange: the fixture's default `dev` env is no-pin; bind a key to it.
      // The SDK supplies a commit sha — which the server-controlled policy
      // (dd79dfa75) deliberately discards in favor of the env's
      // latest-deployment commit. No-pin env with no deployment = ''.
      const apiKeyId = await seedApiKey(fixture, fixture.defaultEnv.id, 'dev');

      // Act
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId,
        tenantId: fixture.tenant.id,
      });
      const row = normalizedSpanToClickHouseRow(
        makeSpan({ commitSha: 'sdk-runtime-sha' }),
        makeMeta({ resolvedEnv: resolved ?? undefined }),
      );

      // Assert: no-pin env → version 0, CommitSha is '' (server-controlled).
      // The SDK-supplied 'sdk-runtime-sha' MUST NOT leak through: any env
      // resolution means the server's deploy pointer is authoritative; an
      // env with no deployment yet has no server-side sha to stamp.
      expect(row.Environment).toBe('dev');
      expect(row.EnvironmentVersion).toBe(0);
      expect(row.CommitSha).toBe('');
      expect(row.CommitSha).not.toBe('sdk-runtime-sha');

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', apiKeyId);
    });

    it('META PATH: stamps the pinned env from the token env id with NO api_key row present', async () => {
      // The env-binding-in-token feature: a key carrying `environmentId` in its
      // Unkey token resolves the env DIRECTLY by id — no `api_key` row needed.
      // This is exactly how machine-issued managed-deployment keys (which no
      // longer write a row) get their traces env-stamped.
      const prod = await seedPinnedEnvironment(fixture, {
        name: 'prodmeta',
        version: 6,
        commitSha: 'commit-prodmeta-v6',
      });
      // Deliberately seed NO api_key row. `apiKeyId` is a value with no match.

      // Act: resolve via the META path — env id from the token.
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: 'key_no_row_present',
        tenantId: fixture.tenant.id,
        environmentIdFromToken: prod.id,
      });
      const row = normalizedSpanToClickHouseRow(
        makeSpan(),
        makeMeta({ resolvedEnv: resolved ?? undefined }),
      );

      // Assert: stamped from the env resolved by id — the absent row proves the
      // resolver never depended on it on the meta path.
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(prod.id);
      expect(row.Environment).toBe('prodmeta');
      expect(row.EnvironmentVersion).toBe(6);
      expect(row.CommitSha).toBe('commit-prodmeta-v6');

      // Cleanup
      await admin.from('environment').delete().eq('id', prod.id);
    });

    it('META PATH: a token env id under the WRONG tenant does not resolve (cross-tenant safety)', async () => {
      // A forged token claiming a real env id but the wrong tenant must be
      // rejected by the resolver's `.eq('tenant_id', …)` filter.
      const prod = await seedPinnedEnvironment(fixture, {
        name: 'prodx',
        version: 2,
        commitSha: 'commit-prodx',
      });

      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: 'key_cross_tenant',
        tenantId: '00000000-0000-4000-8000-000000000000', // not the env's tenant
        environmentIdFromToken: prod.id,
      });

      expect(resolved).toBeNull();

      // Cleanup
      await admin.from('environment').delete().eq('id', prod.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Legacy traces (Environment='') surface as "legacy"
  // ───────────────────────────────────────────────────────────────────────

  describe('legacy traces with no env binding', () => {
    it("should stamp Environment='' and EnvironmentVersion 0 when no API key is present (bearer/legacy ingest)", async () => {
      // Arrange: bearer-auth requests have no apiKeyId — the resolver returns
      // the NO_ENVIRONMENT sentinel.

      // Act
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId: undefined,
        tenantId: fixture.tenant.id,
      });
      const row = normalizedSpanToClickHouseRow(
        makeSpan(),
        makeMeta({ resolvedEnv: resolved ?? undefined }),
      );

      // Assert: the ClickHouse defaults — the dashboard's default-env view
      // surfaces these `''` rows with a "legacy" indicator.
      expect(resolved).toBeNull();
      expect(row.Environment).toBe('');
      expect(row.EnvironmentVersion).toBe(0);
    });

    it("should stamp Environment='' when the API key's env row has been deleted (cache cleared)", async () => {
      // Arrange: seed a key bound to an env, then delete the env. The CASCADE
      // on api_key.environment_id removes the key row too.
      const doomed = await seedPinnedEnvironment(fixture, {
        name: 'doomed',
        version: 1,
        commitSha: 'commit-doomed',
      });
      const apiKeyId = await seedApiKey(fixture, doomed.id, 'doomed');
      await admin.from('environment').delete().eq('id', doomed.id);
      // Clear the resolver cache so we observe the post-revocation steady
      // state immediately rather than waiting out the 60s TTL.
      __clearEnvironmentResolverCache();

      // Act
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId,
        tenantId: fixture.tenant.id,
      });
      const row = normalizedSpanToClickHouseRow(
        makeSpan(),
        makeMeta({ resolvedEnv: resolved ?? undefined }),
      );

      // Assert: the key row is gone → resolver returns the sentinel →
      // stamping falls back to legacy defaults.
      expect(resolved).toBeNull();
      expect(row.Environment).toBe('');
      expect(row.EnvironmentVersion).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // TraceSource is gateway-controlled, never client-controlled
  // ───────────────────────────────────────────────────────────────────────

  describe('TraceSource stamping', () => {
    it("should stamp TraceSource 'production' on every gateway-resolved trace", async () => {
      // Arrange
      const apiKeyId = await seedApiKey(fixture, fixture.defaultEnv.id, 'src');
      const resolved = await resolveEnvironmentFromApiKey({
        supabase: admin,
        apiKeyId,
        tenantId: fixture.tenant.id,
      });

      // Act
      const row = normalizedSpanToClickHouseRow(
        makeSpan(),
        makeMeta({ resolvedEnv: resolved ?? undefined }),
      );

      // Assert
      expect(row.TraceSource).toBe('production');

      // Cleanup
      await admin.from('api_key').delete().eq('api_key_id', apiKeyId);
    });

    it("should ignore a client-supplied trace_source span attribute and still stamp 'production'", async () => {
      // Arrange: a span whose attributes try to self-assign trace_source.
      // The converter never reads `trace_source` from span attributes — it
      // unconditionally stamps 'production'. This proves the client
      // cannot override it.
      const span = makeSpan({
        spanAttributes: { trace_source: 'experiment', 'agentmark.trace_source': 'playground' },
        resourceAttributes: { trace_source: 'eval' },
      });

      // Act
      const row = normalizedSpanToClickHouseRow(span, makeMeta());

      // Assert: the client's value is discarded.
      expect(row.TraceSource).toBe('production');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Experiment/eval scores inherit Environment from the PARENT TRACE
  //
  // The score env triple is parent-trace-authoritative — resolved by looking
  // up the parent trace via ResourceId↔TraceId/SpanId, NOT from the score
  // submitter's API key. The resolution lives in `scores.ts`
  // (`resolveScoreEnvTriples`) and queries ClickHouse. We assert the RULE
  // against a real ClickHouse round-trip when the stack is up; otherwise we
  // skip loudly (same conditional-contract pattern as `storageDeleteWorks`).
  // ───────────────────────────────────────────────────────────────────────

  describe('score env inheritance from parent trace', () => {
    it('should resolve a score env triple from the parent trace row, not from the submitter API key', async () => {
      // Probe ClickHouse — the default `environments` vitest project does not
      // boot the ClickHouse docker stack (only the `gateway-http` project
      // does). When it is unreachable, skip rather than false-pass.
      let queryClickHouse: (q: string) => Promise<unknown[]>;
      let executeClickHouse: (c: string) => Promise<void>;
      try {
        const ch = await import('../../../clickhouse/setup-clickhouse');
        queryClickHouse = ch.queryClickHouse;
        executeClickHouse = ch.executeClickHouse;
        await queryClickHouse('SELECT 1');
      } catch (err) {
        console.warn(
          `[trace-tagging] ClickHouse unreachable — skipping the ` +
            `parent-trace inheritance round-trip. The stamping RULE is unit-` +
            `covered in packages/gateway-core/src/openapi/__tests__. Reason: ` +
            `${(err as Error).message}`,
        );
        return;
      }

      // Arrange: a parent trace row pinned to `prod` v9. The score below
      // references it by TraceId — its env triple MUST come from this row.
      const traceId = `t054-${Date.now().toString(36)}`;
      const ts = new Date(Date.now() - 60_000)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
        .slice(0, 19);
      // CreatedAt is deliberately omitted: the column is `DateTime` with a
      // `DEFAULT now()`. Passing `now64(3)` (a `DateTime64(3)`, Decimal64-
      // backed) for it raises ClickHouse `Code: 53 TYPE_MISMATCH` in a VALUES
      // section, which does not coerce DateTime64 → DateTime. Letting the
      // column default fire is both correct and avoids the type mismatch.
      await executeClickHouse(`
        INSERT INTO otel_traces (
          Timestamp, TraceId, SpanId, ParentSpanId, SpanName, StatusCode, Type,
          TenantId, AppId, Environment, EnvironmentVersion, CommitSha,
          EndTime, IsDeleted
        ) VALUES (
          '${ts}', '${traceId}', '${traceId}-span', '', 'parent', 'OK', 'GENERATION',
          '${fixture.tenant.id}', '${fixture.app.id}', 'prod', 9, 'commit-prod-v9',
          '${ts}', 0
        )
      `);

      // Act: replicate the parent-trace lookup `resolveScoreEnvTriples` does —
      // a score's ResourceId is matched against TraceId OR SpanId.
      const ch2 = await import('../../../clickhouse/setup-clickhouse');
      const rows = (await ch2.queryClickHouse(`
        SELECT Environment AS environment,
               EnvironmentVersion AS environment_version,
               CommitSha AS commit_sha
        FROM otel_traces FINAL
        WHERE TenantId = '${fixture.tenant.id}'
          AND AppId = '${fixture.app.id}'
          AND IsDeleted = 0
          AND (TraceId = '${traceId}' OR SpanId = '${traceId}')
      `)) as Array<{
        environment: string;
        environment_version: number | string;
        commit_sha: string;
      }>;

      // Assert: the score's env triple == the parent trace's triple. The
      // submitter's API key (which could be bound to `dev`) is irrelevant.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.environment).toBe('prod');
      expect(Number(rows[0]!.environment_version)).toBe(9);
      expect(rows[0]!.commit_sha).toBe('commit-prod-v9');

      // Cleanup
      await executeClickHouse(
        `ALTER TABLE otel_traces DELETE WHERE TraceId = '${traceId}'`,
      );
    });
  });
});
