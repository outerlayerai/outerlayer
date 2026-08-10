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

  test('rejects an origin token outside the closed vocabulary', () => {
    expect(ListSessionsQuerySchema.safeParse({ origin: 'agent' }).success).toBe(true);
    expect(ListSessionsQuerySchema.safeParse({ origin: 'bogus' }).success).toBe(false);
  });

  test('every origin token has exactly one SQL literal set', () => {
    expect([...ORIGIN_LITERALS.keys()]).toEqual(['interactive', 'agent', 'worker']);
  });
});
