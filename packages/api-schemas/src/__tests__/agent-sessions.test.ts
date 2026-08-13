import { describe, expect, test } from 'vitest';
import { ListSessionsQuerySchema, MAX_SESSIONS_OFFSET, ORIGIN_LITERALS } from '../schemas/agent-sessions';

describe('ListSessionsQuerySchema', () => {
  test('rejects an offset past the 10,000-row cap', () => {
    expect(ListSessionsQuerySchema.safeParse({ offset: MAX_SESSIONS_OFFSET }).success).toBe(true);
    expect(ListSessionsQuerySchema.safeParse({ offset: MAX_SESSIONS_OFFSET + 1 }).success).toBe(false);
  });

  test('defaults limit/offset/sort/dir when absent', () => {
    const result = ListSessionsQuerySchema.parse({});
    expect(result).toMatchObject({ limit: 25, offset: 0, sort: 'startedAt', dir: 'desc' });
  });

  test('rejects a non-integer limit or offset', () => {
    expect(ListSessionsQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ offset: '3.1' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ limit: '10', offset: '0' }).success).toBe(true);
  });

  test('requires topicId and topicFacet together, not one without the other', () => {
    expect(ListSessionsQuerySchema.safeParse({}).success).toBe(true);
    expect(ListSessionsQuerySchema.safeParse({ topicId: 'v1-c0', topicFacet: 'task' }).success).toBe(true);
    expect(ListSessionsQuerySchema.safeParse({ topicId: 'v1-c0' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ topicFacet: 'task' }).success).toBe(false);
  });

  test('rejects an origin token outside the closed vocabulary', () => {
    expect(ListSessionsQuerySchema.safeParse({ origin: 'agent' }).success).toBe(true);
    expect(ListSessionsQuerySchema.safeParse({ origin: 'bogus' }).success).toBe(false);
  });

  test('every origin token has exactly one SQL literal set', () => {
    expect([...ORIGIN_LITERALS.keys()]).toEqual(['interactive', 'agent', 'worker']);
  });

  test('rejects from/to dates outside ClickHouse\'s safe DateTime range', () => {
    expect(ListSessionsQuerySchema.safeParse({ from: '9999-01-01T00:00:00Z' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ to: '9999-01-01T00:00:00Z' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }).success).toBe(
      true,
    );
  });

  test('rejects a lone UTF-16 surrogate in every free-string filter', () => {
    const LONE_SURROGATE = '\ud800';
    for (const field of ['q', 'repo', 'branch', 'agentType', 'model', 'workerKind', 'actor'] as const) {
      expect(
        ListSessionsQuerySchema.safeParse({ [field]: LONE_SURROGATE }).success,
        `${field} accepted a lone surrogate`,
      ).toBe(false);
    }
    // topicId requires topicFacet to be set alongside it (schema-level refine).
    expect(ListSessionsQuerySchema.safeParse({ topicId: LONE_SURROGATE, topicFacet: 'task' }).success).toBe(false);
  });

  test('valid free-string filter values still pass', () => {
    const result = ListSessionsQuerySchema.safeParse({
      q: 'refund flow',
      repo: 'acme/api',
      branch: 'main',
      agentType: 'claude-code',
      model: 'claude-opus-4-8',
      workerKind: 'cloud',
      actor: 'membership-a',
      topicId: 'v1-c0',
      topicFacet: 'task',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});
