import { describe, expect, it, vi } from 'vitest';
import { buildPrOutcomeReader } from '../pr-outcomes';
import type { ChQueryFn } from '../../openapi/analytics-factory';

/** Chainable Supabase-select stand-in: every `.eq`/`.in`/`.select` returns
 * itself, and `await`-ing it resolves via `.then` — the same shape the real
 * client's builder has. `fromSpy`/`inCalls`/`eqCalls` let tests assert
 * whether a table was ever queried and with what `.in(...)`/`.eq(...)`
 * filter values. */
function fakeSupabase(
  byTable: Record<string, { data: unknown; error: { message: string } | null }>,
  opts: {
    fromSpy?: ReturnType<typeof vi.fn>;
    inCalls?: { table: string; column: string; values: unknown[] }[];
    eqCalls?: { table: string; column: string; value: unknown }[];
  } = {},
) {
  return {
    from: (table: string) => {
      opts.fromSpy?.(table);
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          opts.eqCalls?.push({ table, column, value });
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          opts.inCalls?.push({ table, column, values });
          return chain;
        },
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

  it('never queries Postgres when no ClickHouse client is configured', async () => {
    const fromSpy = vi.fn();
    const supabase = fakeSupabase({}, { fromSpy });

    const reader = buildPrOutcomeReader(supabase as any, null, SCOPE);
    await reader.forSessions(['trace-a']);

    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('an error on the confirmed-links read takes priority over any data present, discarding it', async () => {
    // A real Supabase error response always carries data: null, but the code's
    // own error-first guard is what makes that safe — assert the guard by
    // giving the error response non-null data too (with a fully valid
    // pull_request table so the ONLY thing standing between "the garbage
    // data gets processed" and "it's discarded" is the guard on this line),
    // which only a genuine error-first check discards.
    const supabase = fakeSupabase({
      pull_request_session: {
        data: [{ trace_id: 'trace-a', pr_number: 7 }],
        error: { message: 'boom' },
      },
      pull_request: { data: [{ pr_number: 7, url: 'https://github.com/acme/app/pull/7' }], error: null },
    });
    const chQuery: ChQueryFn = vi.fn(async () => [{ Id: 'whatever', Score: 1, Label: 'merged' }]);

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    expect(outcomeOf('trace-a')).toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('an error on the pr-urls read takes priority over any data present, discarding it', async () => {
    const supabase = fakeSupabase({
      pull_request_session: { data: [{ trace_id: 'trace-a', pr_number: 7 }], error: null },
      pull_request: {
        data: [{ pr_number: 7, url: 'https://github.com/acme/app/pull/7' }],
        error: { message: 'boom' },
      },
    });
    // Every requested score id resolves — so if the garbage pull_request data
    // (with error set) were used instead of being discarded, the outcome
    // would still carry a prUrl. It must not.
    const chQuery: ChQueryFn = vi.fn(async (_sql, params) => {
      const ids = params.ids as string[];
      return ids.map((id) => ({ Id: id, Score: 1, Label: 'merged' }));
    });

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    // The whole read degrades to "no outcomes" — a garbage-but-error-flagged
    // pr_number must never surface a prUrl scraped off a discarded row.
    expect(outcomeOf('trace-a')).toEqual([]);
  });

  it('a confirmed-links read with null data and no error is treated as zero links, never querying ClickHouse', async () => {
    const supabase = fakeSupabase({
      pull_request_session: { data: null as unknown as unknown[], error: null },
    });
    const chQuery: ChQueryFn = vi.fn(async () => []);

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    const outcomeOf = await reader.forSessions(['trace-a']);

    expect(outcomeOf('trace-a')).toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('passes the exact set of confirmed PR numbers as the pull_request .in() filter', async () => {
    const inCalls: { table: string; column: string; values: unknown[] }[] = [];
    const supabase = fakeSupabase(
      {
        pull_request_session: {
          data: [
            { trace_id: 'trace-a', pr_number: 3 },
            { trace_id: 'trace-b', pr_number: 9 },
          ],
          error: null,
        },
        pull_request: { data: [], error: null },
      },
      { inCalls },
    );
    const chQuery: ChQueryFn = vi.fn(async () => []);

    const reader = buildPrOutcomeReader(supabase as any, chQuery, SCOPE);
    await reader.forSessions(['trace-a', 'trace-b']);

    const prUrlsCall = inCalls.find((c) => c.table === 'pull_request')!;
    expect(prUrlsCall.column).toBe('pr_number');
    expect(prUrlsCall.values).toEqual([3, 9]);
  });

  it('scopes both Postgres reads to tenant_id/app_id, and the confirmed-links read to verification="confirmed"', async () => {
    const eqCalls: { table: string; column: string; value: unknown }[] = [];
    const supabase = fakeSupabase(
      {
        pull_request_session: { data: [{ trace_id: 'trace-a', pr_number: 7 }], error: null },
        pull_request: { data: [{ pr_number: 7, url: 'https://github.com/acme/app/pull/7' }], error: null },
      },
      { eqCalls },
    );
    const chQuery: ChQueryFn = vi.fn(async () => []);
    const scope = { tenantId: 'tenant-scoped', appId: 'app-scoped' };

    const reader = buildPrOutcomeReader(supabase as any, chQuery, scope);
    await reader.forSessions(['trace-a']);

    const linksFilters = eqCalls.filter((c) => c.table === 'pull_request_session');
    expect(linksFilters).toEqual(
      expect.arrayContaining([
        { table: 'pull_request_session', column: 'tenant_id', value: scope.tenantId },
        { table: 'pull_request_session', column: 'app_id', value: scope.appId },
        { table: 'pull_request_session', column: 'verification', value: 'confirmed' },
      ]),
    );

    const urlFilters = eqCalls.filter((c) => c.table === 'pull_request');
    expect(urlFilters).toEqual(
      expect.arrayContaining([
        { table: 'pull_request', column: 'tenant_id', value: scope.tenantId },
        { table: 'pull_request', column: 'app_id', value: scope.appId },
      ]),
    );
  });
});
