import { describe, expect, test, vi } from 'vitest';
import {
  AgentSessionsService,
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
  const calls: { query: string; query_params: Record<string, unknown> | undefined }[] = [];
  const client: IClickHouseQuery = {
    query: async (params) => {
      calls.push({ query: params.query, query_params: params.query_params });
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
  });
});

describe('AgentSessionsService.listSessions', () => {
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
});
