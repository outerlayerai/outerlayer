import { describe, expect, it } from 'vitest';
import {
  buildMcpAdoptionQuery,
  buildMcpServerSessionsQuery,
  buildMcpServerToolsQuery,
  buildMcpServerTrendQuery,
} from '../queries-mcp-adoption';

const base = { tenantId: 't1', appId: 'a1', lookbackDays: 90, recentDays: 14 };

describe('buildMcpAdoptionQuery', () => {
  it('reads the mcp_tool_use rollup per server, parameterized and day-windowed', () => {
    const { query, params } = buildMcpAdoptionQuery(base);
    expect(params).toEqual({ tenantId: 't1', appId: 'a1', lookbackDays: 90, recentDays: 14 });
    expect(query).toContain('FROM mcp_tool_use');
    expect(query).toContain('uniqExactMergeIf(Calls, Day >= today() - {recentDays:UInt32})');
    expect(query).toContain('uniqExactIf(TraceId, Day >= today() - {recentDays:UInt32})');
    expect(query).toContain('Day >= today() - {lookbackDays:UInt32}');
    expect(query).toContain('GROUP BY Server');
    // Bound params only — raw values never reach the SQL string.
    expect(query).not.toContain('t1');
    expect(query).not.toContain('a1');
  });

  it('never touches the raw span table and carries no actor identity', () => {
    const { query } = buildMcpAdoptionQuery(base);
    expect(query).not.toContain('otel_traces');
    expect(query).not.toContain('FINAL');
    expect(query).not.toContain('ActorId');
  });
});

describe('per-server drill-down queries', () => {
  const input = { ...base, server: 'playwright' };

  it('tools query groups by Tool with recent/total split — the unused-tool tail signal', () => {
    const { query, params } = buildMcpServerToolsQuery(input);
    expect(params).toEqual({
      tenantId: 't1',
      appId: 'a1',
      server: 'playwright',
      lookbackDays: 90,
      recentDays: 14,
    });
    expect(query).toContain('FROM mcp_tool_use');
    expect(query).toContain('Server = {server:String}');
    expect(query).toContain('GROUP BY Tool');
    expect(query).not.toContain('playwright');
  });

  it('trend query returns a day series for one server', () => {
    const { query, params } = buildMcpServerTrendQuery({
      tenantId: 't1',
      appId: 'a1',
      server: 'playwright',
      lookbackDays: 90,
    });
    expect(params).toEqual({ tenantId: 't1', appId: 'a1', server: 'playwright', lookbackDays: 90 });
    expect(query).toContain('GROUP BY Day');
    expect(query).toContain('ORDER BY Day');
    expect(query).not.toContain('playwright');
  });

  it('sessions query enumerates traces and LEFT-joins titles from the summary', () => {
    const { query, params } = buildMcpServerSessionsQuery({
      tenantId: 't1',
      appId: 'a1',
      server: 'playwright',
      lookbackDays: 90,
      limit: 20,
    });
    expect(params).toEqual({
      tenantId: 't1',
      appId: 'a1',
      server: 'playwright',
      lookbackDays: 90,
      limit: 20,
    });
    expect(query).toContain('GROUP BY TraceId');
    expect(query).toContain('LIMIT {limit:UInt32}');
    // LEFT join: a session with no summary row still called the server.
    expect(query).toContain('LEFT JOIN');
    expect(query).toContain('FROM agent_session_summary');
    expect(query).not.toContain('playwright');
  });

  it('no drill-down query reads raw spans or actor identity', () => {
    for (const { query } of [
      buildMcpServerToolsQuery(input),
      buildMcpServerTrendQuery({ tenantId: 't1', appId: 'a1', server: 's', lookbackDays: 90 }),
      buildMcpServerSessionsQuery({ tenantId: 't1', appId: 'a1', server: 's', lookbackDays: 90, limit: 5 }),
    ]) {
      expect(query).not.toContain('otel_traces');
      expect(query).not.toContain('ActorId');
    }
  });
});
