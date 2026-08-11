import { describe, expect, it, vi } from 'vitest';
import {
  fetchOutcomesForTraces,
  webCryptoOutcomeScoreId,
  OUTCOME_SCORE_NAMES,
  type PrOutcomeLinksReader,
} from '../services/pr-outcomes';

const TENANT = 'tenant-1';
const APP = 'app-1';

/** A fixed-string stand-in for the hash port — behavior tests don't need a
 * real digest, just a deterministic id per (trace, pr, name). */
const testId = (appId: string, traceId: string, prNumber: number, name: string) =>
  `${appId}:${traceId}:${prNumber}:${name}`;

function linksReader(
  links: { traceId: string; prNumber: number }[],
  urls: { prNumber: number; url: string | null }[] = [],
): PrOutcomeLinksReader {
  return {
    confirmedLinks: vi.fn(async () => links),
    prUrls: vi.fn(async () => urls),
  };
}

function stubChQuery(rows: Array<{ Id: string; Score: number; Label: string }>) {
  return vi.fn(async (_sql: string, params: Record<string, unknown>) => {
    const ids = params.ids as string[] | undefined;
    return rows.filter((r) => ids === undefined || ids.includes(r.Id));
  });
}

describe('fetchOutcomesForTraces', () => {
  it('groups outcomes by PR and sorts ascending, matching each score by its recomputed id', async () => {
    const links = linksReader([
      { traceId: 'trace-a', prNumber: 30 },
      { traceId: 'trace-a', prNumber: 12 },
    ]);
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 30, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
      { Id: testId(APP, 'trace-a', 12, OUTCOME_SCORE_NAMES.merged), Score: 0, Label: 'closed' },
    ]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.get('trace-a')).toEqual([
      { prNumber: 12, prUrl: null, ciGreen: null, merged: { score: 0, label: 'closed' }, reverted: null },
      { prNumber: 30, prUrl: null, ciGreen: null, merged: { score: 1, label: 'merged' }, reverted: null },
    ]);
  });

  it('attaches the provider PR url, collapsing null and empty string alike to null', async () => {
    const links = linksReader(
      [
        { traceId: 'trace-a', prNumber: 41 },
        { traceId: 'trace-a', prNumber: 42 },
      ],
      [
        { prNumber: 41, url: 'https://github.com/acme/app/pull/41' },
        { prNumber: 42, url: '' },
      ],
    );
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 41, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
      { Id: testId(APP, 'trace-a', 42, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
    ]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.get('trace-a')!.map((p) => [p.prNumber, p.prUrl])).toEqual([
      [41, 'https://github.com/acme/app/pull/41'],
      [42, null],
    ]);
  });

  it('does not attribute another trace or app id space to this trace — a matching PR number but a different trace has a different id', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = stubChQuery([
      { Id: testId(APP, 'other-trace', 7, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
    ]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.has('trace-a')).toBe(false);
  });

  it('omits a trace with no scored PR from the map entirely', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 10 }]);
    const chQuery = stubChQuery([]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.size).toBe(0);
  });

  it('returns an empty map and never reads links or ClickHouse for an empty trace list', async () => {
    const links = linksReader([]);
    const chQuery = stubChQuery([]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: [],
    });

    expect(result.size).toBe(0);
    expect(links.confirmedLinks).not.toHaveBeenCalled();
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('scopes the ClickHouse read to the given tenant', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
    ]);

    await fetchOutcomesForTraces(links, chQuery, testId, { tenantId: TENANT, appId: APP, traceIds: ['trace-a'] });

    expect(chQuery).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ tenantId: TENANT }));
  });

  it('routes ciGreen, merged, and reverted facts onto their own row fields', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.ciGreen), Score: 1, Label: 'success' },
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.reverted), Score: 0, Label: 'not_reverted' },
    ]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.get('trace-a')).toEqual([
      {
        prNumber: 7,
        prUrl: null,
        ciGreen: { score: 1, label: 'success' },
        merged: { score: 1, label: 'merged' },
        reverted: { score: 0, label: 'not_reverted' },
      },
    ]);
  });

  it('passes confirmedLinks exactly the tenantId, appId, and traceIds it was given', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = stubChQuery([]);

    await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a', 'trace-b'],
    });

    expect(links.confirmedLinks).toHaveBeenCalledWith({
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a', 'trace-b'],
    });
  });

  it('never reads links or ClickHouse for a non-empty traceIds list whose confirmedLinks come back empty', async () => {
    const links = linksReader([]);
    const chQuery = stubChQuery([]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.size).toBe(0);
    expect(links.confirmedLinks).toHaveBeenCalledWith({
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });
    expect(links.prUrls).not.toHaveBeenCalled();
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('passes prUrls the exact deduplicated set of confirmed PR numbers, when at least one link is confirmed', async () => {
    const links = linksReader(
      [
        { traceId: 'trace-a', prNumber: 7 },
        { traceId: 'trace-b', prNumber: 7 },
        { traceId: 'trace-a', prNumber: 9 },
      ],
      [
        { prNumber: 7, url: 'https://github.com/acme/app/pull/7' },
        { prNumber: 9, url: 'https://github.com/acme/app/pull/9' },
      ],
    );
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
    ]);

    await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a', 'trace-b'],
    });

    expect(links.prUrls).toHaveBeenCalledWith({
      tenantId: TENANT,
      appId: APP,
      prNumbers: expect.arrayContaining([7, 9]),
    });
    const call = (links.prUrls as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      prNumbers: number[];
    };
    expect(call.prNumbers).toHaveLength(2);
  });

  it('gives two different traceIds independent PR maps rather than sharing one', async () => {
    const links = linksReader([
      { traceId: 'trace-a', prNumber: 7 },
      { traceId: 'trace-b', prNumber: 8 },
    ]);
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
      { Id: testId(APP, 'trace-b', 8, OUTCOME_SCORE_NAMES.merged), Score: 0, Label: 'closed' },
    ]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a', 'trace-b'],
    });

    expect(result.get('trace-a')).toEqual([
      { prNumber: 7, prUrl: null, ciGreen: null, merged: { score: 1, label: 'merged' }, reverted: null },
    ]);
    expect(result.get('trace-b')).toEqual([
      { prNumber: 8, prUrl: null, ciGreen: null, merged: { score: 0, label: 'closed' }, reverted: null },
    ]);
  });

  it('chunks the ClickHouse Id lookup at the query-chunk boundary, calling chQuery once per chunk with the exact ids in each', async () => {
    const links = linksReader(
      Array.from({ length: 200 }, (_, i) => ({ traceId: `trace-${i}`, prNumber: i })),
    );
    const chQuery = stubChQuery([]);

    await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: Array.from({ length: 200 }, (_, i) => `trace-${i}`),
    });

    // 200 links * 3 score names = 600 candidate ids > QUERY_CHUNK(500), so two chunked calls.
    expect(chQuery).toHaveBeenCalledTimes(2);
    const firstIds = (chQuery.mock.calls[0]![1] as { ids: string[] }).ids;
    const secondIds = (chQuery.mock.calls[1]![1] as { ids: string[] }).ids;
    expect(firstIds).toHaveLength(500);
    expect(secondIds).toHaveLength(100);
  });

  it('passes chQuery the exact set of candidate ids for a small confirmed-link set', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = stubChQuery([]);

    await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    const ids = (chQuery.mock.calls[0]![1] as { ids: string[] }).ids;
    expect(ids).toEqual(
      Object.values(OUTCOME_SCORE_NAMES).map((name) => testId(APP, 'trace-a', 7, name)),
    );
  });

  it('silently drops a raw score row whose Id matches no candidate', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = vi.fn(async () => [
      { Id: 'unrelated-stale-id', Score: 1, Label: 'merged' },
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.merged), Score: 1, Label: 'merged' },
    ]);

    const result = await fetchOutcomesForTraces(links, chQuery, testId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.get('trace-a')).toEqual([
      { prNumber: 7, prUrl: null, ciGreen: null, merged: { score: 1, label: 'merged' }, reverted: null },
    ]);
  });

  it('accepts a synchronous computeId port, not just an async one', async () => {
    const links = linksReader([{ traceId: 'trace-a', prNumber: 7 }]);
    const chQuery = stubChQuery([
      { Id: testId(APP, 'trace-a', 7, OUTCOME_SCORE_NAMES.ciGreen), Score: 1, Label: 'success' },
    ]);
    const syncComputeId = (appId: string, traceId: string, prNumber: number, name: string) =>
      testId(appId, traceId, prNumber, name);

    const result = await fetchOutcomesForTraces(links, chQuery, syncComputeId, {
      tenantId: TENANT,
      appId: APP,
      traceIds: ['trace-a'],
    });

    expect(result.get('trace-a')).toEqual([
      { prNumber: 7, prUrl: null, ciGreen: { score: 1, label: 'success' }, merged: null, reverted: null },
    ]);
  });
});

describe('webCryptoOutcomeScoreId', () => {
  it('is deterministic for the same inputs and distinct across trace/PR/name', async () => {
    const a = await webCryptoOutcomeScoreId('app-1', 'trace-1', 7, 'worker.merged');
    const again = await webCryptoOutcomeScoreId('app-1', 'trace-1', 7, 'worker.merged');
    const otherPr = await webCryptoOutcomeScoreId('app-1', 'trace-1', 8, 'worker.merged');
    const otherName = await webCryptoOutcomeScoreId('app-1', 'trace-1', 7, 'worker.reverted');

    expect(a).toBe(again);
    expect(a).not.toBe(otherPr);
    expect(a).not.toBe(otherName);
  });

  it('produces a UUID-shaped, version-4-variant id', async () => {
    const id = await webCryptoOutcomeScoreId('app-1', 'trace-1', 7, 'worker.merged');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
