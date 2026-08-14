/**
 * HTTP-level coverage for `GET /v1/prs/outcomes` — a headless read route.
 * No entitlement gate, no date window (see `openapi/routes/prs.ts`),
 * dominant-repo scoped like every other `agent_session_summary` read in
 * this suite (GitRepo='org/repo').
 *
 * `steered` is `UserTurnCount > 1` (see `AgentFleetService.getAgentPrAttribution`);
 * cost merges from a second, parallel attribution query keyed on the same
 * (repo, branch, prNumber) group.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrOutcomesResponseSchema } from '@repo/api-schemas';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';

const RUN_ID = randomUUID().slice(0, 8);
const RUN_NUM = parseInt(RUN_ID.slice(0, 6), 16) % 900_000;

const BRANCH_STEERED = `pr-outcomes-steered-${RUN_ID}`;
const PR_STEERED = RUN_NUM + 1;
const TRACE_STEERED = `pr-outcomes-steered-trace-${RUN_ID}`;

const BRANCH_CLEAN = `pr-outcomes-clean-${RUN_ID}`;
const PR_CLEAN = RUN_NUM + 2;
const TRACE_CLEAN = `pr-outcomes-clean-trace-${RUN_ID}`;

describe('GET /v1/prs/outcomes', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();

  beforeAll(async () => {
    // A steered PR: mid-session human intervention (UserTurnCount > 1).
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, PrNumber, UserTurnCount, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_STEERED}','pr-outcomes-steered-session-${RUN_ID}','pr outcomes steered fixture','claude-code','actor-${RUN_ID}',
        'org/repo','${BRANCH_STEERED}',${PR_STEERED},3,'','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 5, 3, 0, 4.5, ['claude-opus-4-8'],
        now(), 'cli'
      )
    `);
    // A clean (non-steered) PR: UserTurnCount = 1, the initial ask only.
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, PrNumber, UserTurnCount, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_CLEAN}','pr-outcomes-clean-session-${RUN_ID}','pr outcomes clean fixture','claude-code','actor-${RUN_ID}',
        'org/repo','${BRANCH_CLEAN}',${PR_CLEAN},1,'','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 2, 1, 0, 1.25, ['claude-opus-4-8'],
        now(), 'cli'
      )
    `);

    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId IN ('${TRACE_STEERED}', '${TRACE_CLEAN}') FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId IN ('${TRACE_STEERED}', '${TRACE_CLEAN}')`);
  });

  // proves AC-052-17
  it('conforms to PrOutcomesResponseSchema and merges attribution with per-group cost', async () => {
    const res = await gatewayFetch('/v1/prs/outcomes');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = PrOutcomesResponseSchema.safeParse(body);
    expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

    const data = (body as {
      data: {
        branches: string[];
        prNumbers: number[];
        steeredPrNumbers: number[];
        items: Array<{ repo: string; branch: string; prNumber: number; steered: boolean; costUsd: number }>;
      };
    }).data;

    expect(data.branches).toEqual(expect.arrayContaining([BRANCH_STEERED, BRANCH_CLEAN]));
    expect(data.prNumbers).toEqual(expect.arrayContaining([PR_STEERED, PR_CLEAN]));
    expect(data.steeredPrNumbers).toContain(PR_STEERED);
    expect(data.steeredPrNumbers).not.toContain(PR_CLEAN);

    const steeredItem = data.items.find((i) => i.prNumber === PR_STEERED);
    expect(steeredItem).toEqual({ repo: 'org/repo', branch: BRANCH_STEERED, prNumber: PR_STEERED, steered: true, costUsd: 4.5 });

    const cleanItem = data.items.find((i) => i.prNumber === PR_CLEAN);
    expect(cleanItem).toEqual({ repo: 'org/repo', branch: BRANCH_CLEAN, prNumber: PR_CLEAN, steered: false, costUsd: 1.25 });
  });
});
