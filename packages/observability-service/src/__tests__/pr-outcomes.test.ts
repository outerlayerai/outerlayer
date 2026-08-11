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
