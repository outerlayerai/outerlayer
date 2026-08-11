/**
 * Acceptance: the Context Overview's inventory ∪ usage join against BOTH real
 * stores — the mirrored inventory under real Supabase RLS, and the usage
 * rollups under the real ClickHouse row-policy read identity. This is the
 * deep-tier binding for the data-integrity criteria; the component suite
 * (tenant-dashboard `context-overview.test.tsx`) proves the client half of
 * the same ids with the server seam mocked.
 *
 * What must hold, driven through the real `getOverview` composition
 * (RLS-scoped tree read → row-policy ClickHouse reads → pure join):
 *   - seeded activations/sessions come back as the row figures and the
 *     session-coverage rollup — computed from real rollup-table reads, not
 *     fixtures (AC-058-01's data half);
 *   - a repo skill with NO usage still yields a zero row while the app
 *     provably has sessions — the exact inputs the never verdict gates on
 *     (AC-058-04's data half);
 *   - usage for a name absent from the repo is flagged `inRepo: false` and
 *     kept only while the selected window still holds its activity
 *     (AC-058-06's data half).
 *
 * The read client is constructed exactly like the dashboard's
 * `createTenantReadClient` (analytics_reader + SQL_tenant_id/SQL_app_id
 * row-policy settings) — the env-based factory is module-mocked because the
 * harness pins the dashboard's ClickHouse env to undefined (test-setup.ts);
 * the queries, identities, and policies are real. Runs under the
 * `clickhouse` vitest project (container + analytics_reader global-setup).
 */

import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  type SameTenantUser,
} from '../custom-roles/helpers';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';

// Hoisted so the (also-hoisted) vi.mock factory below can register every
// client it hands out for afterAll cleanup.
const { clients } = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock('tenant-dashboard/src/lib/analytics/client', async () => {
  const { createClient } = await import('@clickhouse/client');
  const setup = await import('../../../clickhouse/setup-clickhouse');
  return {
    createTenantReadClient: (scope: { tenantId: string; appId: string }) => {
      const client = createClient({
        url: setup.CLICKHOUSE_TEST_HOST,
        username: setup.CLICKHOUSE_TEST_READ_USER,
        password: setup.CLICKHOUSE_TEST_READ_PASSWORD,
        database: 'default',
        clickhouse_settings: { SQL_tenant_id: scope.tenantId, SQL_app_id: scope.appId },
      });
      clients.push(client);
      return client;
    },
  };
});

import { getOverview } from 'tenant-dashboard/src/features/context/service';

const RUN = randomBytes(4).toString('hex');
const SESSIONS = 10;
/** Traces 0–5 activate `alpha`; 6–7 activate the removed `ghost`; 8–9 none. */
const ALPHA_TRACES = 6;
const GHOST_TRACES = [6, 7];
const SPANS_PER_TRACE = 2;

describe('context overview — inventory ∪ usage join over real Supabase RLS + ClickHouse row policies', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let appId: string;
  const alpha = `alpha-${RUN}`;
  const dormant = `dormant-${RUN}`;
  const ghost = `ghost-${RUN}`;
  const ancient = `ancient-${RUN}`;

  beforeAll(async () => {
    owner = await createTenantWithOwner();

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `ctx-overview-${RUN}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id;

    const { error: gitError } = await admin
      .from('git_connection')
      .insert({ app_id: appId, tenant_id: owner.tenantId, provider: 'github', repository: `octo/ctx-ov-${RUN}`, created_by: owner.id });
    if (gitError) throw new Error(`git_connection insert: ${gitError.message}`);
    const { error: branchError } = await admin
      .from('git_branch')
      .insert({ app_id: appId, tenant_id: owner.tenantId, branch_name: 'main' });
    if (branchError) throw new Error(`git_branch insert: ${branchError.message}`);

    const { data: snap, error: snapError } = await admin
      .from('context_snapshot')
      .insert({ tenant_id: owner.tenantId, app_id: appId, commit_sha: `commit-${RUN}`, classifier_version: 1 })
      .select('id')
      .single();
    if (snapError) throw new Error(`snapshot insert: ${snapError.message}`);

    const blob = (sha: string, content: string) => ({
      tenant_id: owner.tenantId,
      app_id: appId,
      blob_sha: sha,
      content,
      size: content.length,
    });
    await admin.from('context_blob').insert([
      blob(`sha-agents-${RUN}`, '# AGENTS.md'),
      blob(`sha-alpha-${RUN}`, `---\nname: ${alpha}\ndescription: d\n---\n`),
      blob(`sha-dormant-${RUN}`, `---\nname: ${dormant}\ndescription: d\n---\n`),
      blob(`sha-mcp-${RUN}`, JSON.stringify({ mcpServers: { github: {} } })),
    ]);

    const entry = (path: string, sha: string, kind: string) => ({
      snapshot_id: snap!.id,
      tenant_id: owner.tenantId,
      app_id: appId,
      path,
      blob_sha: sha,
      kind,
      scope_path: '.outerlayer',
    });
    await admin.from('context_tree_entry').insert([
      entry('.outerlayer/AGENTS.md', `sha-agents-${RUN}`, 'instructions'),
      entry(`.outerlayer/skills/${alpha}/SKILL.md`, `sha-alpha-${RUN}`, 'skill'),
      entry(`.outerlayer/skills/${dormant}/SKILL.md`, `sha-dormant-${RUN}`, 'skill'),
      entry('.outerlayer/mcp.json', `sha-mcp-${RUN}`, 'mcp'),
    ]);

    const { error: headError } = await admin.from('context_head').insert({
      app_id: appId,
      tenant_id: owner.tenantId,
      branch: 'main',
      commit_sha: `commit-${RUN}`,
      snapshot_id: snap!.id,
    });
    if (headError) throw new Error(`context_head insert: ${headError.message}`);

    // --- ClickHouse usage, keyed to the same tenant/app/traces. Sessions
    // land day (n % 7) ago, so everything sits inside the 30d range AND the
    // 14d recent window; `ancient` gets one burst 40 days ago (inside the 90d
    // lookback, outside the 30d range) to prove the orphan-drop rule.
    const T = owner.tenantId;
    await executeClickHouse(`
      INSERT INTO agent_session_summary (TenantId, AppId, TraceId, SessionId, Title, AgentType, StartedAt, EndedAt, InsertedAt)
      SELECT '${T}', '${appId}', concat('trace-ov-${RUN}-', toString(number)), concat('sess-${RUN}-', toString(number)),
             concat('Session ', toString(number)), 'claude-code',
             now() - toIntervalDay(number % 7), now() - toIntervalDay(number % 7) + toIntervalMinute(9), now()
      FROM numbers(${SESSIONS})`);

    const seedSkill = async (skill: string, tracePredicate: string, dayExpr: string) => {
      await executeClickHouse(`
        INSERT INTO skill_activation_by_day
        SELECT TenantId, AppId, Skill, Day, uniqExactState(TraceId, SpanId, idx), uniqExactState(TraceId), max(ts)
        FROM (
          SELECT '${T}' AS TenantId, '${appId}' AS AppId, '${skill}' AS Skill,
                 today() - (${dayExpr}) AS Day,
                 concat('trace-ov-${RUN}-', toString(number)) AS TraceId,
                 concat('span-', '${skill}', '-', toString(number), '-', toString(rep)) AS SpanId,
                 toUInt32(rep) AS idx,
                 toDateTime64(now() - toIntervalDay(${dayExpr}), 9) AS ts
          FROM numbers(${SESSIONS}) ARRAY JOIN range(${SPANS_PER_TRACE}) AS rep
          WHERE ${tracePredicate}
        )
        GROUP BY TenantId, AppId, Skill, Day`);
      await executeClickHouse(`
        INSERT INTO skill_activation_sessions
        SELECT TenantId, AppId, Skill, Day, TraceId, uniqExactState(SpanId, idx), max(ts)
        FROM (
          SELECT '${T}' AS TenantId, '${appId}' AS AppId, '${skill}' AS Skill,
                 today() - (${dayExpr}) AS Day,
                 concat('trace-ov-${RUN}-', toString(number)) AS TraceId,
                 concat('span-', '${skill}', '-', toString(number), '-', toString(rep)) AS SpanId,
                 toUInt32(rep) AS idx,
                 toDateTime64(now() - toIntervalDay(${dayExpr}), 9) AS ts
          FROM numbers(${SESSIONS}) ARRAY JOIN range(${SPANS_PER_TRACE}) AS rep
          WHERE ${tracePredicate}
        )
        GROUP BY TenantId, AppId, Skill, Day, TraceId`);
    };
    await seedSkill(alpha, `number < ${ALPHA_TRACES}`, 'number % 7');
    await seedSkill(ghost, `number IN (${GHOST_TRACES.join(',')})`, 'number % 7');
    await seedSkill(ancient, 'number = 0', '40');

    await executeClickHouse(`
      INSERT INTO mcp_tool_use
      SELECT TenantId, AppId, Server, Tool, Day, TraceId, uniqExactState(SpanId), max(ts)
      FROM (
        SELECT '${T}' AS TenantId, '${appId}' AS AppId, 'github' AS Server,
               arrayElement(['create_pull_request', 'get_issue'], toUInt32(number % 2) + 1) AS Tool,
               today() - (number % 7) AS Day,
               concat('trace-ov-${RUN}-', toString(number)) AS TraceId,
               concat('span-mcp-', toString(number)) AS SpanId,
               toDateTime64(now() - toIntervalDay(number % 7), 9) AS ts
        FROM numbers(5)
      )
      GROUP BY TenantId, AppId, Server, Tool, Day, TraceId`);
  }, 120000);

  afterAll(async () => {
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await Promise.all((clients as ClickHouseClient[]).map((client) => client.close().catch(() => {})));
  });

  // AC-058-01 (data half: the rollup figures are computed from real stores)
  it('joins seeded inventory and usage into real row figures and session coverage', async () => {
    const result = await getOverview(owner.client as never, { tenantId: owner.tenantId, appId }, '30d');

    expect(result.degraded).toBe(false);

    // Positional over the whole row set: activations-desc ordering, the
    // in-repo flags, and the figures in one assert — a reorder, a dropped
    // row, or a wrong count all fail here.
    expect(result.skills.map((row) => [row.skillName, row.inRepo, row.activations])).toEqual([
      [alpha, true, ALPHA_TRACES * SPANS_PER_TRACE],
      [ghost, false, GHOST_TRACES.length * SPANS_PER_TRACE],
      [dormant, true, 0],
    ]);

    const alphaRow = result.skills[0]!;
    expect(alphaRow).toEqual({
      skillName: alpha,
      scopePath: '',
      inRepo: true,
      activations: ALPHA_TRACES * SPANS_PER_TRACE,
      priorActivations: 0,
      sessions: ALPHA_TRACES,
      recentActivations: ALPHA_TRACES * SPANS_PER_TRACE,
      lookbackActivations: ALPHA_TRACES * SPANS_PER_TRACE,
      lastActivatedAt: expect.any(String),
      // One rollup point per seeded day (traces 0–5 land on days 0–5).
      trend: expect.any(Array),
      issues: [],
    });
    expect(alphaRow.trend).toHaveLength(ALPHA_TRACES);
    expect(alphaRow.trend.reduce((sum, point) => sum + point.activations, 0)).toBe(
      ALPHA_TRACES * SPANS_PER_TRACE,
    );

    // Coverage: 10 seeded sessions; traces 0–5 (alpha) and 6–7 (ghost)
    // activated a skill → 8 of 10, straight from the session-grain rollup.
    // The prior 30d window was seeded empty, so the prior counts are zero.
    expect(result.coverage).toEqual({
      sessions: SESSIONS,
      sessionsWithSkill: ALPHA_TRACES + GHOST_TRACES.length,
      priorSessions: 0,
      priorSessionsWithSkill: 0,
      lookbackSessions: SESSIONS,
    });

    expect(result.mcpServers).toEqual([
      {
        serverName: 'github',
        configPath: '.outerlayer/mcp.json',
        inRepo: true,
        calls: 5,
        priorCalls: 0,
        sessions: 5,
        recentCalls: 5,
        lookbackCalls: 5,
        toolsUsed: 2,
        lastUsedAt: expect.any(String),
      },
    ]);

    expect(result.inventory).toEqual({ instructionScopes: 1, commands: 0, subagents: 0 });
  });

  // AC-058-04 (data half: the verdict's inputs — a zero usage row for
  // in-repo inventory while the app provably has sessions)
  it('yields a zero row for an installed skill nothing activated, alongside real session evidence', async () => {
    const result = await getOverview(owner.client as never, { tenantId: owner.tenantId, appId }, '30d');

    const dormantRow = result.skills.find((row) => row.skillName === dormant);
    expect(dormantRow).toEqual({
      skillName: dormant,
      scopePath: '',
      inRepo: true,
      activations: 0,
      priorActivations: 0,
      sessions: 0,
      recentActivations: 0,
      lookbackActivations: 0,
      lastActivatedAt: null,
      trend: [],
      issues: [],
    });
    // The first-run gate must be OPEN — the never verdict is earned, not defaulted.
    expect(result.coverage!.lookbackSessions).toBeGreaterThan(0);
  });

  // AC-058-06 (data half: name-keyed usage without inventory)
  it('marks usage for a removed skill inRepo:false, and drops orphans with no activity in the window', async () => {
    const result = await getOverview(owner.client as never, { tenantId: owner.tenantId, appId }, '30d');

    const ghostRow = result.skills.find((row) => row.skillName === ghost);
    expect(ghostRow).toEqual({
      skillName: ghost,
      scopePath: null,
      inRepo: false,
      activations: GHOST_TRACES.length * SPANS_PER_TRACE,
      priorActivations: 0,
      sessions: GHOST_TRACES.length,
      recentActivations: GHOST_TRACES.length * SPANS_PER_TRACE,
      lookbackActivations: GHOST_TRACES.length * SPANS_PER_TRACE,
      lastActivatedAt: expect.any(String),
      trend: expect.any(Array),
      issues: [],
    });

    // `ancient` has lookback history but nothing in the 30d window — a
    // removed skill's stale history must not linger as a row.
    expect(result.skills.map((row) => row.skillName)).not.toContain(ancient);
  });
});
