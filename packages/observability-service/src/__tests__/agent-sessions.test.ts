import { describe, expect, test, vi } from 'vitest';
import {
  AgentSessionsService,
  AGENT_SESSIONS_QUERY_SETTINGS,
  ANONYMOUS_ACTOR_LABEL,
  type AgentSessionsPorts,
  type SessionAccessPolicy,
} from '../services/agent-sessions';
import type { IClickHouseQuery } from '../client';
import { ValidationError } from '../errors';

const SCOPE = { tenantId: 'tenant-1', appId: 'app-1' };

const BASE_QUERY = {
  limit: 25,
  offset: 0,
  sort: 'startedAt' as const,
  dir: 'desc' as const,
};

function noopPorts(): AgentSessionsPorts {
  return {
    actorNames: { resolve: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `Name(${id})`])) },
    prOutcomes: { forSessions: async () => () => [] },
    images: { sign: async () => [] },
  };
}

/** A fake CH client whose responses are queued in call order, except a
 * `dispatch` map keyed on a SQL substring for reads whose call order isn't
 * fixed (the repo/vocab reads under listSessions). */
function fakeClient(opts: {
  byNeedle?: { needle: string; rows: unknown[] }[];
  queue?: unknown[][];
}) {
  const queue = [...(opts.queue ?? [])];
  const calls: {
    query: string;
    query_params: Record<string, unknown> | undefined;
    clickhouse_settings: Record<string, unknown> | undefined;
  }[] = [];
  const client: IClickHouseQuery = {
    query: async (params) => {
      calls.push({
        query: params.query,
        query_params: params.query_params,
        clickhouse_settings: params.clickhouse_settings as Record<string, unknown> | undefined,
      });
      const match = opts.byNeedle?.find((n) => params.query.includes(n.needle));
      const rows = match ? match.rows : (queue.shift() ?? []);
      return { json: async <T>() => rows as T[] };
    },
  };
  return { client, calls };
}

describe('AgentSessionsService.getSessionDetail', () => {
  const rootSpan = (over: Record<string, unknown> = {}) => ({
    spanId: 's0',
    parentSpanId: null,
    name: 'agent.session',
    startTime: '2026-01-01 00:00:00.000',
    durationMs: 100,
    statusCode: '1',
    statusMessage: null,
    model: null,
    cost: null,
    inputTokens: null,
    outputTokens: null,
    input: null,
    output: null,
    reasoning: null,
    captureTier: 'full',
    agentType: 'claude-code',
    actorId: 'membership-a',
    metadata: {},
    ...over,
  });

  test('dashboard-member without team scope cannot read another actor\'s session', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'dashboard-member', membershipId: 'someone-else', canSeeTeam: false };
    const result = await service.getSessionDetail(SCOPE, 'trace-1', policy, noopPorts());
    expect(result).toBeNull();
  });

  test('dashboard-member self-pinned to the SAME actor reads their own session', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'dashboard-member', membershipId: 'membership-a', canSeeTeam: false };
    const result = await service.getSessionDetail(SCOPE, 'trace-1', policy, noopPorts());
    expect(result?.session.actorId).toBe('membership-a');
  });

  // proves AC-052-05
  test('machine-key without team-actor visibility masks the actor name but still returns the row', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: false };
    const result = await service.getSessionDetail(SCOPE, 'trace-1', policy, noopPorts());
    expect(result?.session.actorId).toBe('membership-a'); // row visible
    expect(result?.session.actorName).toBe(ANONYMOUS_ACTOR_LABEL); // identity masked
  });

  test('machine-key with team-actor visibility resolves a real name', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: true };
    const result = await service.getSessionDetail(SCOPE, 'trace-1', policy, noopPorts());
    expect(result?.session.actorName).toBe('Name(membership-a)');
  });

  test('returns null for a nonexistent trace', async () => {
    const { client } = fakeClient({ queue: [[], [], []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: true };
    const result = await service.getSessionDetail(SCOPE, 'trace-missing', policy, noopPorts());
    expect(result).toBeNull();
  });

  test('a resolved trace time-range bounds the span scan', async () => {
    const { client, calls } = fakeClient({
      queue: [[{ start: '2026-01-01 00:00:00.000000000', end: '2026-01-01 01:00:00.000000000' }], [rootSpan()], []],
    });
    const service = new AgentSessionsService(client);
    await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    const spanQuery = calls.find((c) => c.query.includes('FROM otel_traces FINAL'))!;
    expect(spanQuery.query).toContain('Timestamp >= {tsRangeStart:DateTime64(9)}');
    expect(spanQuery.query_params?.['tsRangeStart']).toBe('2026-01-01 00:00:00.000000000');
  });

  test('pasted images on a span are parsed and signed', async () => {
    const withImage = rootSpan({ metadata: { images: JSON.stringify([{ sha256: 'abc', mediaType: 'image/png' }]) } });
    const { client } = fakeClient({ queue: [[], [withImage], []] });
    const service = new AgentSessionsService(client);
    const sign = vi.fn().mockResolvedValue([{ sha256: 'abc', mediaType: 'image/png', token: 't' }]);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      { ...noopPorts(), images: { sign } },
    );
    expect(sign).toHaveBeenCalledWith([{ sha256: 'abc', mediaType: 'image/png' }]);
    expect(result?.spans[0]!.images).toEqual([{ sha256: 'abc', mediaType: 'image/png', token: 't' }]);
  });

  test('malformed image metadata degrades to no images rather than throwing', async () => {
    const withBadImage = rootSpan({ metadata: { images: '{not json' } });
    const { client } = fakeClient({ queue: [[], [withBadImage], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.images).toEqual([]);
  });

  // proves AC-052-13
  test('a session over the 2000-span cap is truncated to exactly 2000 rows, flagged', async () => {
    const spans = [rootSpan(), ...Array.from({ length: 2100 }, (_, i) => rootSpan({ spanId: `s${i + 1}`, name: 'agent.turn.assistant' }))];
    const { client } = fakeClient({ queue: [[], spans.slice(0, 2001), []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: true };
    const result = await service.getSessionDetail(SCOPE, 'trace-1', policy, noopPorts());
    expect(result?.truncated).toBe(true);
    expect(result?.spans).toHaveLength(2000);
  });

  test('a session under the cap is not flagged truncated', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: true };
    const result = await service.getSessionDetail(SCOPE, 'trace-1', policy, noopPorts());
    expect(result?.truncated).toBe(false);
  });

  test('turn I/O in the gen_ai messages-array shape unwraps to joined content strings', async () => {
    const withMessages = rootSpan({
      name: 'agent.turn.user',
      input: JSON.stringify([{ role: 'user', content: 'first line' }, { role: 'user', content: 'second line' }]),
    });
    const { client } = fakeClient({ queue: [[], [withMessages], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toBe('first line\nsecond line');
  });

  test('a malformed JSON-looking input string passes through unwrapped', async () => {
    const bad = rootSpan({ name: 'agent.turn.user', input: '[not valid json' });
    const { client } = fakeClient({ queue: [[], [bad], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toBe('[not valid json');
  });

  test('every emitted query carries the ClickHouse resource caps', async () => {
    const { client, calls } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.clickhouse_settings).toEqual(AGENT_SESSIONS_QUERY_SETTINGS);
    }
  });

  test('a resolved trace time range with only one bound present leaves the scan unbounded', async () => {
    const { client, calls } = fakeClient({
      queue: [[{ start: '2026-01-01 00:00:00.000000000', end: undefined }], [rootSpan()], []],
    });
    const service = new AgentSessionsService(client);
    await service.getSessionDetail(SCOPE, 'trace-1', { kind: 'machine-key', canSeeTeamActors: true }, noopPorts());
    const spanQuery = calls.find((c) => c.query.includes('FROM otel_traces FINAL'))!;
    expect(spanQuery.query).not.toContain('tsRangeStart');
  });

  test('a lookup failure on the time-range query falls back to an unbounded scan', async () => {
    const client: IClickHouseQuery = {
      query: async (params) => {
        if (params.query.includes('otel_traces_trace_id_ts')) throw new Error('boom');
        if (params.query.includes('FROM otel_traces FINAL')) return { json: async <T>() => [rootSpan()] as T[] };
        return { json: async <T>() => [] as T[] };
      },
    };
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.traceId).toBe('trace-1');
  });

  test('exactly MAX_SESSION_SPANS rows is not flagged truncated', async () => {
    const spans = [rootSpan(), ...Array.from({ length: 1999 }, (_, i) => rootSpan({ spanId: `s${i + 1}`, name: 'agent.turn.assistant' }))];
    expect(spans).toHaveLength(2000);
    const { client } = fakeClient({ queue: [[], spans, []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.truncated).toBe(false);
    expect(result?.spans).toHaveLength(2000);
  });

  test('when no row is named agent.session, the first row stands in as root', async () => {
    const notRoot = rootSpan({ spanId: 'sX', name: 'agent.turn.assistant', actorId: 'membership-z' });
    const { client } = fakeClient({ queue: [[], [notRoot], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.actorId).toBe('membership-z');
  });

  test('an empty summary-row result leaves summary fields at their no-summary defaults', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.hookExecutionCount).toBe(0);
    expect(result?.session.permissionPromptCount).toBe(0);
    expect(result?.session.apiErrorCount).toBe(0);
    expect(result?.session.slowestHookCommand).toBe('');
  });

  const richSummary = {
    sessionId: 'session-99',
    workerKind: 'cloud',
    costUsd: 4.5,
    durationMs: 9000,
    userTurnCount: 3,
    rejectedToolCallCount: 2,
    permissionPromptCount: 1,
    apiErrorCount: 5,
    hookExecutionCount: 7,
    hookDurationMs: 1200,
    hookUnreportedCount: 1,
    slowestHookMs: 600,
    slowestHookCommand: 'eslint --fix',
  };

  test('every field on a fully-populated span + summary row maps to its exact value', async () => {
    const full = rootSpan({
      parentSpanId: 'parent-1',
      durationMs: 250,
      statusMessage: 'ok',
      model: 'claude-opus-4-8',
      cost: 0.02,
      inputTokens: 10,
      outputTokens: 20,
      output: 'the output',
      reasoning: 'the reasoning',
      captureTier: 'lite',
      metadata: { title: 'My Session', workerKind: 'meta-worker', gitRepo: 'acme/app', cwd: '/tmp' },
    });
    const { client } = fakeClient({ queue: [[], [full], [richSummary]] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session).toEqual({
      traceId: 'trace-1',
      sessionId: 'session-99',
      title: 'My Session',
      agentType: 'claude-code',
      actorId: 'membership-a',
      actorName: 'Name(membership-a)',
      workerKind: 'cloud',
      project: 'acme/app',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 9000,
      turnCount: 0,
      toolCallCount: 0,
      errorCount: 0,
      costUsd: 4.5,
      models: [],
      captureTier: 'lite',
      userTurnCount: 3,
      rejectedToolCallCount: 2,
      permissionPromptCount: 1,
      apiErrorCount: 5,
      editRetryLoop: null,
      hookExecutionCount: 7,
      hookDurationMs: 1200,
      hookUnreportedCount: 1,
      slowestHookMs: 600,
      slowestHookCommand: 'eslint --fix',
    });
    expect(result?.spans[0]).toEqual({
      spanId: 's0',
      parentSpanId: 'parent-1',
      name: 'agent.session',
      startTime: '2026-01-01T00:00:00.000Z',
      durationMs: 250,
      statusCode: '1',
      statusMessage: 'ok',
      model: 'claude-opus-4-8',
      cost: 0.02,
      inputTokens: 10,
      outputTokens: 20,
      input: null,
      output: 'the output',
      reasoning: 'the reasoning',
      metadata: full.metadata,
      images: [],
    });
  });

  test('a bare span with every optional field absent falls back to null, not zero or empty string', async () => {
    const bare = rootSpan({ parentSpanId: null, durationMs: 0, cost: 0, inputTokens: 0, outputTokens: 0 });
    const { client } = fakeClient({ queue: [[], [bare], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.parentSpanId).toBeNull();
    expect(result?.spans[0]!.durationMs).toBeNull();
    expect(result?.spans[0]!.cost).toBeNull();
    expect(result?.spans[0]!.inputTokens).toBeNull();
    expect(result?.spans[0]!.outputTokens).toBeNull();
    expect(result?.session.durationMs).toBeNull();
    expect(result?.session.costUsd).toBeNull();
    expect(result?.session.workerKind).toBeNull();
    expect(result?.session.project).toBeNull();
    expect(result?.session.title).toBeNull();
  });

  test('summary duration/cost of exactly 0 falls back to the root span, not through as zero', async () => {
    const withCost = rootSpan({ name: 'agent.turn.assistant', cost: 1.5 });
    const zeroSummary = { ...richSummary, costUsd: 0, durationMs: 0 };
    const { client } = fakeClient({ queue: [[], [rootSpan(), withCost], [zeroSummary]] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.costUsd).toBe(1.5); // spanCostSum, not the zero summary cost
    expect(result?.session.durationMs).toBe(100); // root span's own durationMs (100), not the zero summary
  });

  test('userTurnCount and rejected count are derived from spans when no summary row exists', async () => {
    const userTurn = rootSpan({ spanId: 's1', name: 'agent.turn.user' });
    const rejectedTool = rootSpan({
      spanId: 's2',
      name: 'agent.tool.bash',
      metadata: { toolStatus: 'rejected' },
    });
    const acceptedTool = rootSpan({ spanId: 's3', name: 'agent.tool.read', metadata: { toolStatus: 'ok' } });
    const rejectedNonTool = rootSpan({ spanId: 's4', name: 'agent.turn.user', metadata: { toolStatus: 'rejected' } });
    const { client } = fakeClient({
      queue: [[], [rootSpan(), userTurn, rejectedTool, acceptedTool, rejectedNonTool], []],
    });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.userTurnCount).toBe(2); // userTurn + rejectedNonTool, both agent.turn.user
    expect(result?.session.rejectedToolCallCount).toBe(1); // only the tool span whose status is rejected
  });

  test('errorCount counts only agent.tool spans with statusCode 2, not other statuses or non-tool spans', async () => {
    const failedTool = rootSpan({ spanId: 's1', name: 'agent.tool.bash', statusCode: '2' });
    const okTool = rootSpan({ spanId: 's2', name: 'agent.tool.read', statusCode: '1' });
    const nonToolError = rootSpan({ spanId: 's3', name: 'agent.turn.assistant', statusCode: '2' });
    const { client } = fakeClient({ queue: [[], [rootSpan(), failedTool, okTool, nonToolError], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.errorCount).toBe(1);
    expect(result?.session.toolCallCount).toBe(2); // failedTool + okTool, agent.tool.*
  });

  test('turnCount only counts agent.turn.* spans, matched by prefix not suffix', async () => {
    const turn = rootSpan({ spanId: 's1', name: 'agent.turn.assistant' });
    const notATurnSuffix = rootSpan({ spanId: 's2', name: 'weird.agent.turn.' }); // ends with agent.turn. but doesn't start with it
    const { client } = fakeClient({ queue: [[], [rootSpan(), turn, notATurnSuffix], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.turnCount).toBe(1);
  });

  test('models dedupe and drop blanks, in first-seen order', async () => {
    const t1 = rootSpan({ spanId: 's1', name: 'agent.turn.assistant', model: 'gpt-5' });
    const t2 = rootSpan({ spanId: 's2', name: 'agent.turn.assistant', model: 'gpt-5' });
    const t3 = rootSpan({ spanId: 's3', name: 'agent.turn.assistant', model: null });
    const t4 = rootSpan({ spanId: 's4', name: 'agent.turn.assistant', model: 'claude-opus-4-8' });
    const { client } = fakeClient({ queue: [[], [rootSpan(), t1, t2, t3, t4], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.models).toEqual(['gpt-5', 'claude-opus-4-8']);
  });

  test('workerKind prefers the summary rollup over the span metadata fallback', async () => {
    const withMeta = rootSpan({ metadata: { workerKind: 'meta-worker' } });
    const { client } = fakeClient({ queue: [[], [withMeta], [{ ...richSummary, workerKind: 'summary-worker' }]] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.workerKind).toBe('summary-worker');
  });

  test('project prefers gitRepo over cwd when both are present', async () => {
    const withBoth = rootSpan({ metadata: { gitRepo: 'acme/app', cwd: '/tmp' } });
    const { client } = fakeClient({ queue: [[], [withBoth], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.session.project).toBe('acme/app');
  });

  test('the actor-name resolver returning no entry for the actor falls back to the raw actorId', async () => {
    const { client } = fakeClient({ queue: [[], [rootSpan()], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      { ...noopPorts(), actorNames: { resolve: async () => ({}) } },
    );
    expect(result?.session.actorName).toBe('membership-a');
  });

  test('a payload longer than the IO cap is truncated to exactly the cap length', async () => {
    const long = rootSpan({ name: 'agent.turn.user', input: JSON.stringify('x'.repeat(5000)) });
    const { client } = fakeClient({ queue: [[], [long], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toHaveLength(4096);
  });

  test('a payload exactly at the IO cap is left untouched', async () => {
    const exact = rootSpan({ name: 'agent.turn.user', input: 'y'.repeat(4096) });
    const { client } = fakeClient({ queue: [[], [exact], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toBe('y'.repeat(4096));
    expect(result?.spans[0]!.input).toHaveLength(4096);
  });

  test('a message array missing "content" on one entry is not unwrapped as messages', async () => {
    const notMessages = rootSpan({
      name: 'agent.turn.user',
      input: JSON.stringify([{ role: 'user' }]),
    });
    const { client } = fakeClient({ queue: [[], [notMessages], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toBe(JSON.stringify([{ role: 'user' }]));
  });

  test('an empty array is not treated as a messages array (passed through as-is)', async () => {
    const emptyArr = rootSpan({ name: 'agent.turn.user', input: '[]' });
    const { client } = fakeClient({ queue: [[], [emptyArr], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toBe('[]');
  });

  test('a non-string message content is JSON-stringified rather than dropped', async () => {
    const nonStringContent = rootSpan({
      name: 'agent.turn.user',
      input: JSON.stringify([{ role: 'user', content: { nested: 'value' } }]),
    });
    const { client } = fakeClient({ queue: [[], [nonStringContent], []] });
    const service = new AgentSessionsService(client);
    const result = await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(result?.spans[0]!.input).toBe(JSON.stringify({ nested: 'value' }));
  });

  test('an image with a non-string sha256 is dropped, and a missing mediaType defaults to image/png', async () => {
    const withImages = rootSpan({
      metadata: {
        images: JSON.stringify([
          { sha256: 42, mediaType: 'image/jpeg' },
          { sha256: 'abc' },
        ]),
      },
    });
    const { client } = fakeClient({ queue: [[], [withImages], []] });
    const service = new AgentSessionsService(client);
    const sign = vi.fn().mockResolvedValue([]);
    await service.getSessionDetail(
      SCOPE,
      'trace-1',
      { kind: 'machine-key', canSeeTeamActors: true },
      { ...noopPorts(), images: { sign } },
    );
    expect(sign).toHaveBeenCalledWith([{ sha256: 'abc', mediaType: 'image/png' }]);
  });
});

describe('AgentSessionsService.listSessions', () => {
  // proves AC-052-05
  test('machine-key without team-actor visibility rejects an explicit actor filter', async () => {
    const { client } = fakeClient({ queue: [] });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: false };
    await expect(
      service.listSessions(SCOPE, { ...BASE_QUERY, actor: 'membership-a' }, policy, noopPorts()),
    ).rejects.toThrow(ValidationError);
  });

  test('machine-key always returns team-scoped rows — never row-pinned', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: false };
    const page = await service.listSessions(SCOPE, BASE_QUERY, policy, noopPorts());
    expect(page.scope).toBe('team');
    // The repo-resolution query must NOT carry an ActorId pin.
    const repoQuery = calls.find((c) => c.query.includes('GROUP BY GitRepo'))!;
    expect(repoQuery.query).not.toContain('ActorId={actor:String}');
  });

  test('dashboard-member without team scope is pinned to their own actor', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'dashboard-member', membershipId: 'me', canSeeTeam: false };
    const page = await service.listSessions(SCOPE, BASE_QUERY, policy, noopPorts());
    expect(page.scope).toBe('self');
    const repoQuery = calls.find((c) => c.query.includes('GROUP BY GitRepo'))!;
    expect(repoQuery.query).toContain('ActorId={actor:String}');
    expect(repoQuery.query_params?.['actor']).toBe('me');
  });

  test('machine-key with team-actor visibility masks nothing and allows the actor filter', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [{ traceId: 't1', sessionId: 't1', actorId: 'a1', startedAt: '2026-01-01 00:00:00', durationMs: 0, turnCount: 0, toolCallCount: 0, errorCount: 0, userTurnCount: 0, rejectedToolCallCount: 0, costUsd: 0, models: [] }] },
        { needle: 'SELECT count() AS total', rows: [{ total: '1' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '1', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: true };
    const page = await service.listSessions(SCOPE, { ...BASE_QUERY, actor: 'a1' }, policy, noopPorts());
    expect(page.total).toBe(1);
    expect(page.actorNames['a1']).toBe('Name(a1)');
  });

  test('an unpinned team read anonymizes every actor name when the policy denies team-actor visibility', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [{ traceId: 't1', sessionId: 't1', actorId: 'a1', startedAt: '2026-01-01 00:00:00', durationMs: 0, turnCount: 0, toolCallCount: 0, errorCount: 0, userTurnCount: 0, rejectedToolCallCount: 0, costUsd: 0, models: [] }] },
        { needle: 'SELECT count() AS total', rows: [{ total: '1' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '1', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: false };
    const page = await service.listSessions(SCOPE, BASE_QUERY, policy, noopPorts());
    expect(page.actorNames['a1']).toBe(ANONYMOUS_ACTOR_LABEL);
  });

  test('a topic drill-down never resolves a dominant repo — it spans repos', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: true };
    await service.listSessions(
      SCOPE,
      { ...BASE_QUERY, topicId: 'v1-c0', topicFacet: 'task' },
      policy,
      noopPorts(),
    );
    expect(calls.some((c) => c.query.includes('GROUP BY GitRepo'))).toBe(false);
  });

  test('an issues drill-down widens to sessions whose SUBAGENT matched, not only the root trace', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    await service.listSessions(
      SCOPE,
      { ...BASE_QUERY, topicId: 'v1-c0', topicFacet: 'issues' },
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    const listQuery = calls.find((c) => c.query.includes('TraceId AS traceId'))!;
    expect(listQuery.query).toContain('SessionId IN (');
    expect(listQuery.query).not.toContain("Origin != 'agent'");
  });

  test('every optional filter composes into the WHERE clause with its param bound', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
        { needle: 'GROUP BY GitBranch', rows: [{ branch: 'main' }] },
        { needle: 'GROUP BY ActorId', rows: [{ actor: 'a1' }] },
        { needle: 'GROUP BY AgentType', rows: [{ agentType: 'claude-code' }] },
        { needle: 'GROUP BY model', rows: [{ model: 'anthropic/claude-opus-4-8' }] },
        { needle: 'GROUP BY WorkerKind', rows: [{ workerKind: 'cloud' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      {
        ...BASE_QUERY,
        branch: 'main',
        agentType: 'claude-code',
        model: 'anthropic/claude-opus-4-8',
        workerKind: 'cloud',
        q: 'fix bug',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
        signal: 'tool-errors',
        origin: 'agent,worker',
        includeSubagents: '1',
      },
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(page.branches).toEqual(['main']);
    expect(page.agentTypes).toEqual(['claude-code']);
    expect(page.models).toEqual(['anthropic/claude-opus-4-8']);
    expect(page.workerKinds).toEqual(['cloud']);

    const listQuery = calls.find((c) => c.query.includes('TraceId AS traceId'))!;
    expect(listQuery.query).toContain('GitBranch={branch:String}');
    expect(listQuery.query).toContain('AgentType={agentType:String}');
    expect(listQuery.query).toContain('has(Models, {model:String})');
    expect(listQuery.query).toContain('WorkerKind={workerKind:String}');
    expect(listQuery.query).toContain('positionCaseInsensitive(Title, {q:String}) > 0');
    expect(listQuery.query).toContain('StartedAt >= parseDateTimeBestEffort({from:String})');
    expect(listQuery.query).toContain('StartedAt <= parseDateTimeBestEffort({to:String})');
    expect(listQuery.query).toContain('ErrorCount > 0'); // tool-errors signal
    expect(listQuery.query).toContain("Origin IN ('agent', 'worker')");
    // includeSubagents=1 drops the default top-level-only pin.
    expect(listQuery.query).not.toContain("ParentSessionId = ''");
    expect(listQuery.query_params).toMatchObject({
      branch: 'main',
      agentType: 'claude-code',
      model: 'anthropic/claude-opus-4-8',
      workerKind: 'cloud',
      q: 'fix bug',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T00:00:00.000Z',
    });
  });

  test('an unrecognized origin token is dropped rather than reaching the SQL', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    await service.listSessions(
      SCOPE,
      { ...BASE_QUERY, origin: 'agent,bogus' },
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    const listQuery = calls.find((c) => c.query.includes('TraceId AS traceId'))!;
    expect(listQuery.query).toContain("Origin IN ('agent')");
  });

  test('dashboard-member with team scope resolves an unpinned dominant repo', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      BASE_QUERY,
      { kind: 'dashboard-member', membershipId: 'me', canSeeTeam: true },
      noopPorts(),
    );
    expect(page.scope).toBe('team');
    const repoQuery = calls.find((c) => c.query.includes('GROUP BY GitRepo'))!;
    expect(repoQuery.query).not.toContain('ActorId={actor:String}');
  });

  test('an explicit repo skips the dominant-repo resolution query entirely', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      { ...BASE_QUERY, repo: 'acme/other' },
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(page.repo).toBe('acme/other');
    expect(calls.some((c) => c.query.includes('GROUP BY GitRepo'))).toBe(false);
  });

  test('ascending sort direction is honored, not always DESC', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    await service.listSessions(
      SCOPE,
      { ...BASE_QUERY, dir: 'asc' },
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    const listQuery = calls.find((c) => c.query.includes('TraceId AS traceId'))!;
    expect(listQuery.query).toContain('ORDER BY StartedAt ASC');
  });

  test('no optional filters produces a bare WHERE clause with none of the optional predicates', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    await service.listSessions(SCOPE, BASE_QUERY, { kind: 'machine-key', canSeeTeamActors: true }, noopPorts());
    const listQuery = calls.find((c) => c.query.includes('TraceId AS traceId'))!;
    for (const clause of [
      'GitBranch=',
      'AgentType=',
      'has(Models',
      'WorkerKind=',
      'ActorId=',
      'positionCaseInsensitive',
      'StartedAt >=',
      'StartedAt <=',
      'Origin IN',
    ]) {
      expect(listQuery.query).not.toContain(clause);
    }
    expect(listQuery.query).toContain("ParentSessionId = ''");
    expect(listQuery.query_params).not.toHaveProperty('branch');
    expect(listQuery.query_params).not.toHaveProperty('agentType');
    expect(listQuery.query_params).not.toHaveProperty('model');
    expect(listQuery.query_params).not.toHaveProperty('workerKind');
    expect(listQuery.query_params).not.toHaveProperty('actor');
    expect(listQuery.query_params).not.toHaveProperty('q');
    expect(listQuery.query_params).not.toHaveProperty('from');
    expect(listQuery.query_params).not.toHaveProperty('to');
  });

  test('only one of topicId/topicFacet does not activate topic mode', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    await service.listSessions(
      SCOPE,
      { ...BASE_QUERY, topicId: 'v1-c0' },
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(calls.some((c) => c.query.includes('GROUP BY GitRepo'))).toBe(true);
    const listQuery = calls.find((c) => c.query.includes('TraceId AS traceId'))!;
    expect(listQuery.query).not.toContain('TraceId IN (');
  });

  test('a masked machine-key read with no actor filter requested proceeds without throwing, unlike an explicit filter', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'machine-key', canSeeTeamActors: false };
    const page = await service.listSessions(SCOPE, BASE_QUERY, policy, noopPorts());
    expect(page.total).toBe(0);
  });

  test('a pinned actor read carries the ActorId predicate into the vocab (branches/actors/models) queries too', async () => {
    const { client, calls } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
        { needle: 'GROUP BY GitBranch', rows: [] },
        { needle: 'GROUP BY ActorId', rows: [] },
        { needle: 'GROUP BY AgentType', rows: [] },
        { needle: 'GROUP BY model', rows: [] },
        { needle: 'GROUP BY WorkerKind', rows: [] },
      ],
    });
    const service = new AgentSessionsService(client);
    const policy: SessionAccessPolicy = { kind: 'dashboard-member', membershipId: 'me', canSeeTeam: false };
    await service.listSessions(SCOPE, BASE_QUERY, policy, noopPorts());
    const branchQuery = calls.find((c) => c.query.includes('GROUP BY GitBranch'))!;
    expect(branchQuery.query).toContain('ActorId={actor:String}');
    expect(branchQuery.query_params?.['actor']).toBe('me');
  });

  test('total, originCounts, and each session row map every field from the raw CH row', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        {
          needle: 'TraceId AS traceId',
          rows: [
            {
              traceId: 't1',
              sessionId: '',
              title: '',
              agentType: 'claude-code',
              actorId: 'a1',
              workerKind: '',
              project: '',
              branch: '',
              startedAt: '2026-01-01 00:00:00',
              durationMs: 0,
              turnCount: 3,
              toolCallCount: 4,
              errorCount: 1,
              costUsd: 2.5,
              models: ['m1'],
              userTurnCount: 2,
              rejectedToolCallCount: 1,
              origin: '',
            },
          ],
        },
        { needle: 'SELECT count() AS total', rows: [{ total: '7' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '3', agent: '2', worker: '2' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      BASE_QUERY,
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(page.total).toBe(7);
    expect(page.originCounts).toEqual({ interactive: 3, agent: 2, worker: 2 });
    expect(page.sessions[0]).toEqual({
      traceId: 't1',
      sessionId: 't1', // falls back to traceId when sessionId is ''
      title: null,
      agentType: 'claude-code',
      actorId: 'a1',
      workerKind: null,
      project: null,
      branch: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: null, // 0 durationMs -> null, not 0
      turnCount: 3,
      toolCallCount: 4,
      errorCount: 1,
      userTurnCount: 2,
      rejectedToolCallCount: 1,
      costUsd: 2.5,
      models: ['m1'],
      origin: '',
      prOutcomes: [],
    });
  });

  test('a positive row durationMs is preserved as-is, not nulled', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        {
          needle: 'TraceId AS traceId',
          rows: [
            {
              traceId: 't1',
              sessionId: 't1',
              title: 'Title',
              agentType: 'claude-code',
              actorId: 'a1',
              workerKind: 'cloud',
              project: 'acme/app',
              branch: 'main',
              startedAt: '2026-01-01 00:00:00',
              durationMs: 500,
              turnCount: 1,
              toolCallCount: 1,
              errorCount: 0,
              costUsd: 0,
              models: [],
              userTurnCount: 1,
              rejectedToolCallCount: 0,
              origin: 'agent',
            },
          ],
        },
        { needle: 'SELECT count() AS total', rows: [{ total: '1' }] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '1', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      BASE_QUERY,
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(page.sessions[0]!.durationMs).toBe(500);
    expect(page.sessions[0]!.costUsd).toBeNull(); // costUsd 0 -> null via knownCost
  });

  test('an empty originCounts row is omitted from the page entirely, not defaulted to zeros', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [{ total: '0' }] },
        { needle: 'countIf(Origin', rows: [] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      BASE_QUERY,
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(page).not.toHaveProperty('originCounts');
  });

  test('an empty total-row result defaults total to 0', async () => {
    const { client } = fakeClient({
      byNeedle: [
        { needle: 'GROUP BY GitRepo', rows: [{ repo: 'acme/app' }] },
        { needle: 'TraceId AS traceId', rows: [] },
        { needle: 'SELECT count() AS total', rows: [] },
        { needle: 'countIf(Origin', rows: [{ interactive: '0', agent: '0', worker: '0' }] },
      ],
    });
    const service = new AgentSessionsService(client);
    const page = await service.listSessions(
      SCOPE,
      BASE_QUERY,
      { kind: 'machine-key', canSeeTeamActors: true },
      noopPorts(),
    );
    expect(page.total).toBe(0);
  });
});
