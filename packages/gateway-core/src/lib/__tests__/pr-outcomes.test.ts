import { describe, expect, it, vi } from 'vitest';
import { buildPrOutcomeReader } from '../pr-outcomes';
import type { ChQueryFn } from '../../openapi/analytics-factory';

/** Chainable Supabase-select stand-in: every `.eq`/`.in`/`.select` returns
 * itself, and `await`-ing it resolves via `.then` — the same shape the real
 * client's builder has. */
function fakeSupabase(byTable: Record<string, { data: unknown; error: { message: string } | null }>) {
  return {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve(byTable[table]).then(resolve, reject),
      };
      return chain;
    },
  };
}

const SCOPE = { tenantId: 'tenant-1', appId: 'app-1' };

describe('buildPrOutcomeReader', () => {
  it('returns [] for every trace with no ClickHouse client configured, never reading Postgres', async () => {
    const supabase = fakeSupabase({});
    const reader = buildPrOutcomeReader(supabase as any, null, SCOPE);

    const outcomeOf = await reader.forSessions(['trace-a']);

    expect(outcomeOf('trace-a')).toEqual([]);
  });

  it('joins confirmed links to PR urls and ClickHouse scores into one outcome per PR', async () => {
    const supabase = fakeSupabase({
      pull_request_session: {
        data: [{ trace_id: 'trace-a', pr_number: 7 }],
        error: null,
      },
      pull_request: {
        data: [{ pr_number: 7, url: 'https://github.com/acme/app/pull/7' }],
        error: null,
      },
    });
    const chQuery: ChQueryFn = vi.fn(async (_sql, params) => {
      const ids = params.ids as string[];
      // Whichever id the reader computed for (app-1, trace-a, 7, worker.merged)
      // is opaque here — the score just needs to answer every requested id.
      return ids.map((id) => ({ Id: id, Score: 1, Label: 'merged' }));
    });

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    const outcomes = outcomeOf('trace-a');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      prNumber: 7,
      prUrl: 'https://github.com/acme/app/pull/7',
      merged: { score: 1, label: 'merged' },
    });
  });

  it('degrades to [] for every trace when the pull_request_session read fails', async () => {
    const supabase = fakeSupabase({
      pull_request_session: { data: null, error: { message: 'boom' } },
    });
    const chQuery: ChQueryFn = vi.fn(async () => []);

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    expect(outcomeOf('trace-a')).toEqual([]);
  });

  it('degrades to [] for every trace when the pull_request url read fails', async () => {
    const supabase = fakeSupabase({
      pull_request_session: { data: [{ trace_id: 'trace-a', pr_number: 7 }], error: null },
      pull_request: { data: null, error: { message: 'boom' } },
    });
    const chQuery: ChQueryFn = vi.fn(async () => []);

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    expect(outcomeOf('trace-a')).toEqual([]);
  });

  it('returns [] for a trace with no confirmed link, never reading the pull_request table', async () => {
    const supabase = fakeSupabase({
      pull_request_session: { data: [], error: null },
    });
    const prUrls = vi.fn();
    (supabase as any).from = (table: string) => {
      if (table === 'pull_request') prUrls();
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return chain;
    };
    const chQuery: ChQueryFn = vi.fn(async () => []);

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    expect(outcomeOf('trace-a')).toEqual([]);
    expect(prUrls).not.toHaveBeenCalled();
  });
});
