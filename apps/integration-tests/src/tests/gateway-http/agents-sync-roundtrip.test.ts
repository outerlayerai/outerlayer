/**
 * Agent-session sync round-trip and its load budget.
 *
 * The full data-plane chain, every leg REAL:
 *
 *   fixture transcripts → the BUILT `outerlayer` CLI (`dist/index.js sync`,
 *   spawned as a subprocess — arg parsing, scanning, tier redaction, batching
 *   and the wire headers all included) → gateway `/v1/agents/sync` (wrangler
 *   dev, real peppered key auth) → ClickHouse `agent_session_summary` →
 *   read back as the row-policy'd `analytics_reader` — the identity the
 *   dashboard's analytics reads run as.
 *
 * Assertions:
 *   1. Load budget: 1,000 sessions sync in under 2 minutes,
 *      all accepted, none rejected.
 *   2. The row policy serves the data: a tenant-scoped reader sees exactly
 *      this run's 1,000 sessions with NO WHERE-clause help, and a foreign
 *      tenant scope sees zero of them.
 *   3. The CLI sends `x-outerlayer-app-id` — a green run here is
 *      continuous proof the deployed gateway keeps accepting the go-forward
 *      header on its real auth path.
 *
 * Session ids are dash-formatted 32-hex (UUID-shaped), so the gateway's
 * traceIdForSession passes them through verbatim (agent-session-converter):
 * this run's rows are exactly `TraceId LIKE '<RUN_HEX>%'`.
 *
 * Tunable: SYNC_ROUNDTRIP_SESSIONS (default 1000) — turn it down for quick
 * local iteration; CI runs the full load budget.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTestApiKey, getTestTenantId } from './client';
import { GATEWAY_URL, getTestAppId } from '../../../gateway-http/setup-gateway';
import {
  CLICKHOUSE_TEST_HOST,
  CLICKHOUSE_TEST_READ_USER,
  CLICKHOUSE_TEST_READ_PASSWORD,
  executeClickHouse,
  queryClickHouse,
} from '../../../clickhouse/setup-clickhouse';
import { waitForClickHouseData } from '../../helpers/wait-for-clickhouse';

const SESSIONS = Number(process.env.SYNC_ROUNDTRIP_SESSIONS ?? 1000);
const SYNC_BUDGET_MS = 120_000; // load budget: 1k sessions < 2 min

// 20 hex chars of run nonce + 12 hex chars of index = a 32-hex session id
// that traceIdForSession passes through as the TraceId (prefix-searchable).
const RUN_HEX = randomBytes(10).toString('hex');
const sessionIdFor = (i: number): string => {
  const hex = RUN_HEX + i.toString(16).padStart(12, '0');
  // Dash-format like a real vendor session id (8-4-4-4-12).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const CLI_DIST = resolve(
  __dirname,
  '../../../../../packages/cli/dist/index.js',
);

/**
 * Ingest-state breakdown for a Leg-2 failure.
 *
 * Leg 2 can only time out in a state that should be unreachable: the gateway
 * acked every session (Leg 1 asserts `synced === SESSIONS` with an empty
 * `rejected`), and `/v1/agents/sync` awaits a SYNCHRONOUS ClickHouse insert
 * before it acks — `async_insert` is 0 on the test server, so an ack means the
 * part is written and immediately queryable. A timeout therefore means rows the
 * server accepted are not readable, which is a data-loss signal, not a slow
 * test. A bare "timed out after 60000ms" cannot tell those apart, so failures
 * carry the evidence needed to place the loss:
 *
 *   - summary vs span counts: the route inserts otel_traces BEFORE
 *     agent_session_summary through one client, so spans-present-summaries-
 *     missing isolates the failure to the final insert of the batch.
 *   - distinct TraceIds: separates "rows missing" from "rows collapsed" by the
 *     ReplacingMergeTree key.
 *   - pending mutations: this suite's cleanups are async `ALTER … DELETE`s;
 *     a backlog here means deletes are the suspect, not inserts.
 */
async function describeIngestState(): Promise<string> {
  const probes: Array<[string, string]> = [
    [
      'agent_session_summary rows (this run)',
      `SELECT count() AS v FROM agent_session_summary WHERE TraceId LIKE '${RUN_HEX}%'`,
    ],
    [
      'agent_session_summary distinct TraceIds (this run)',
      `SELECT uniqExact(TraceId) AS v FROM agent_session_summary WHERE TraceId LIKE '${RUN_HEX}%'`,
    ],
    [
      'otel_traces spans (this run)',
      `SELECT count() AS v FROM otel_traces WHERE TraceId LIKE '${RUN_HEX}%'`,
    ],
    [
      'agent_session_summary rows (all runs)',
      `SELECT count() AS v FROM agent_session_summary`,
    ],
    [
      'unfinished mutations on agent_session_summary',
      `SELECT count() AS v FROM system.mutations WHERE table = 'agent_session_summary' AND is_done = 0`,
    ],
  ];
  const lines: string[] = [];
  for (const [label, sql] of probes) {
    try {
      const rows = await queryClickHouse(`${sql} FORMAT JSONEachRow`);
      lines.push(`  ${label}: ${rows.length > 0 ? rows[0].v : '(no rows)'}`);
    } catch (e) {
      lines.push(`  ${label}: probe failed — ${String(e)}`);
    }
  }
  return lines.join('\n');
}

/** Query as the row-policy'd read user (same shape as the red-team suite). */
async function readerQuery(
  sql: string,
  settings: Record<string, string> = {},
): Promise<{ ok: boolean; text: string }> {
  const url = new URL(CLICKHOUSE_TEST_HOST);
  url.searchParams.set('user', CLICKHOUSE_TEST_READ_USER);
  url.searchParams.set('password', CLICKHOUSE_TEST_READ_PASSWORD);
  url.searchParams.set('default_format', 'JSONEachRow');
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'POST', body: sql });
  return { ok: res.ok, text: (await res.text()).trim() };
}

let root: string;
let home: string;

describe('agents sync round-trip — CLI → gateway → ClickHouse → policy-scoped read', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ol-roundtrip-root-'));
    home = mkdtempSync(join(tmpdir(), 'ol-roundtrip-home-'));
    // One project dir, SESSIONS transcripts of two lines each — the minimal
    // valid claude-code shape the CLI's own tests use.
    const dir = join(root, '-Users-x-roundtrip');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < SESSIONS; i += 1) {
      const id = sessionIdFor(i);
      const lines = [
        {
          sessionId: id,
          type: 'user',
          version: '2.1.193',
          cwd: '/home/x/roundtrip',
          gitBranch: 'main',
          timestamp: '2026-07-10T09:59:59.000Z',
          message: { role: 'user', content: [{ type: 'text', text: `fix issue ${i}` }] },
        },
        {
          sessionId: id,
          type: 'assistant',
          version: '2.1.193',
          cwd: '/home/x/roundtrip',
          gitBranch: 'main',
          timestamp: '2026-07-10T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        },
      ];
      writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    await executeClickHouse(
      `ALTER TABLE agent_session_summary DELETE WHERE TraceId LIKE '${RUN_HEX}%'`,
    );
  });

  it(
    `syncs ${SESSIONS} sessions through the real CLI under the ${SYNC_BUDGET_MS / 1000}s load AC, and the row-policy'd reader serves them back`,
    // A wall-clock throughput AC on shared CI runners fails probabilistically
    // under neighbouring load, not from code regressions; one retry absorbs
    // that contention noise while each attempt still enforces the full
    // SYNC_BUDGET_MS budget and SESSIONS count, so the capability claim holds.
    { timeout: SYNC_BUDGET_MS + 60_000, retry: 1 },
    async () => {
      // --- Leg 1: the real CLI against the real gateway --------------------
      const started = Date.now();
      const run = spawnSync(
        process.execPath,
        [
          CLI_DIST,
          'sync',
          '--root', root,
          '--codex-root', join(root, 'no-codex'),
          '--cursor-root', join(root, 'no-cursor'),
          '--json',
        ],
        {
          env: {
            ...process.env,
            HOME: home, // hermetic: checkpoint db, cloud config, raw roots
            OUTERLAYER_URL: GATEWAY_URL,
            OUTERLAYER_API_KEY: getTestApiKey(),
            OUTERLAYER_APP_ID: getTestAppId(),
          },
          encoding: 'utf8',
          timeout: SYNC_BUDGET_MS + 30_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const elapsedMs = Date.now() - started;

      expect(run.status, `CLI exited non-zero.\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);
      const result = JSON.parse(run.stdout.trim()) as {
        scanned: number;
        eligible: number;
        synced: number;
        rejected: Array<{ id?: string; reason: string }>;
      };
      expect(result.rejected).toEqual([]);
      expect(result.synced).toBe(SESSIONS);
      expect(
        elapsedMs,
        `load budget:  sessions must sync in <${SYNC_BUDGET_MS}ms (took ${elapsedMs}ms)`,
      ).toBeLessThan(SYNC_BUDGET_MS);

      // --- Leg 2: rows landed in ClickHouse (writer view) ------------------
      // The gateway acked all SESSIONS above and its insert is synchronous, so
      // the rows are already durable here; the poll only absorbs the read-path
      // lag of a part becoming visible. A timeout means accepted rows are
      // missing — see describeIngestState for why that is a data-loss signal
      // and what its breakdown localizes.
      try {
        await waitForClickHouseData({
          query: `SELECT count() AS n FROM agent_session_summary WHERE TraceId LIKE '${RUN_HEX}%' FORMAT JSONEachRow`,
          condition: (rows) => rows.length > 0 && Number(rows[0].n) >= SESSIONS,
          timeoutMs: 60_000,
        });
      } catch (e) {
        throw new Error(
          `Leg 2: the gateway acked ${SESSIONS} session(s) (Leg 1 asserted synced === ${SESSIONS}, ` +
            `rejected === []) but fewer than ${SESSIONS} are readable.\n` +
            `${String(e)}\nIngest state:\n${await describeIngestState()}`,
        );
      }

      // --- Leg 3: the dashboard's identity reads them under the row policy --
      const tenantId = getTestTenantId();
      const scoped = await readerQuery(
        `SELECT count() AS n FROM agent_session_summary WHERE TraceId LIKE '${RUN_HEX}%'`,
        { SQL_tenant_id: tenantId },
      );
      expect(scoped.ok, scoped.text).toBe(true);
      expect(Number((JSON.parse(scoped.text) as { n: number | string }).n)).toBe(SESSIONS);

      // AC-3: every synced row carries the resolved run origin. The real CLI
      // stamped it client-side (seat on a laptop, ci under a pipeline's
      // CI=true) and the gateway persisted it to the WorkerKind column.
      const expectedKind = process.env.CI === 'true' || process.env.CI === '1' ? 'ci' : 'seat';
      const kinds = await readerQuery(
        `SELECT DISTINCT WorkerKind AS k FROM agent_session_summary WHERE TraceId LIKE '${RUN_HEX}%'`,
        { SQL_tenant_id: tenantId },
      );
      expect(kinds.ok, kinds.text).toBe(true);
      expect((JSON.parse(kinds.text) as { k: string }).k).toBe(expectedKind);

      // A foreign tenant's scope sees NONE of this run's sessions — even
      // asking for them by TraceId prefix.
      const foreign = await readerQuery(
        `SELECT count() AS n FROM agent_session_summary WHERE TraceId LIKE '${RUN_HEX}%'`,
        { SQL_tenant_id: `not-${tenantId}` },
      );
      expect(foreign.ok, foreign.text).toBe(true);
      expect(Number((JSON.parse(foreign.text) as { n: number | string }).n)).toBe(0);

      // And a scope-less read fails closed rather than leaking.
      const scopeless = await readerQuery(
        `SELECT count() FROM agent_session_summary`,
      );
      expect(scopeless.ok).toBe(false);
      expect(scopeless.text).toContain('UNKNOWN_SETTING');
    },
  );
});
