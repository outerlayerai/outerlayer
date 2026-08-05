import { describe, expect, test, vi } from 'vitest';
import {
  FACET_NAMING_GUIDANCE,
  MAX_TOPIC_NAME_LENGTH,
  NAMING_CLUSTERS_PER_CALL,
  buildNamingSystemPrompt,
  clusterKeywords,
  nameTopics,
} from '../topic-namer';
import type { StructuredModelClient } from '../structured-model-client';

const REFUND_CLUSTER = {
  topicId: 'v1-c0',
  summaries: [
    'Customer wanted a refund for a delayed shipment.',
    'Customer demanded a refund because the shipment never arrived.',
    'Refund requested after shipment tracking stalled.',
  ],
};

const LOGIN_CLUSTER = {
  topicId: 'v1-c1',
  summaries: [
    'Customer could not login after a password change.',
    'Login kept failing until the password was reset.',
  ],
};

describe('clusterKeywords', () => {
  test('surfaces cluster-distinguishing terms, damping cross-cluster boilerplate', () => {
    const keywords = clusterKeywords(REFUND_CLUSTER, [REFUND_CLUSTER, LOGIN_CLUSTER], 3);
    // 'customer' appears in both clusters → damped below refund-specific terms.
    expect(keywords.slice(0, 2)).toEqual(['refund', 'shipment']);
    expect(keywords).not.toContain('customer');
  });

  test('is deterministic (count desc, then alphabetical)', () => {
    const a = clusterKeywords(REFUND_CLUSTER, [REFUND_CLUSTER, LOGIN_CLUSTER]);
    const b = clusterKeywords(REFUND_CLUSTER, [REFUND_CLUSTER, LOGIN_CLUSTER]);
    expect(a).toEqual(b);
  });
});

describe('buildNamingSystemPrompt', () => {
  test('inserts the facet guidance verbatim between the preamble and the shared rules', () => {
    const prompt = buildNamingSystemPrompt(FACET_NAMING_GUIDANCE['task']);
    expect(prompt).toContain('never');
    expect(prompt).toContain(FACET_NAMING_GUIDANCE['task']!);
    expect(prompt.indexOf(FACET_NAMING_GUIDANCE['task']!)).toBeLessThan(
      prompt.indexOf('For EACH cluster produce:'),
    );
    // Decorative-date ban is a shared rule, present for every facet.
    expect(prompt).toContain('years/dates');
  });

  test('without guidance, the generic pattern paragraph fills the slot — the prompt never references absent guidance', () => {
    const prompt = buildNamingSystemPrompt();
    expect(prompt).toContain('The\ndescription states that pattern plainly.');
  });

  test('task guidance forbids the failure framing that leaked onto task maps', () => {
    // The live defect: task descriptions shipped as "Pattern: …; fix by …" —
    // remediation advice on clusters that describe ordinary work.
    expect(FACET_NAMING_GUIDANCE['task']).toContain('start with "Pattern:"');
    expect(FACET_NAMING_GUIDANCE['task']).toContain('not a diagnosis');
    expect(FACET_NAMING_GUIDANCE['task']).toContain('prescribe fixes');
  });
});

describe('nameTopics', () => {
  test('empty input returns [] without calling the model', async () => {
    const client: StructuredModelClient = { generateObject: vi.fn() };
    expect(await nameTopics([], { client })).toEqual([]);
    expect(client.generateObject).not.toHaveBeenCalled();
  });

  test('the guidance option reaches the naming request systemPrompt', async () => {
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockResolvedValue({ topics: [] }),
    };
    await nameTopics([REFUND_CLUSTER], {
      client,
      guidance: FACET_NAMING_GUIDANCE['steering'],
    });
    expect(client.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: buildNamingSystemPrompt(FACET_NAMING_GUIDANCE['steering']),
      }),
    );
  });

  test('without a client, keyword fallback names are produced', async () => {
    const result = await nameTopics([REFUND_CLUSTER, LOGIN_CLUSTER]);
    expect(result).toEqual([
      {
        topicId: 'v1-c0',
        name: 'Refund Shipment Arrived',
        description: 'Sessions about refund, shipment, arrived.',
        fallback: true,
      },
      {
        topicId: 'v1-c1',
        name: 'Login Password Change',
        description: 'Sessions about login, password, change.',
        fallback: true,
      },
    ]);
  });

  test('a chunk-sized batch is named in exactly one model call with keywords + capped exemplars', async () => {
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [
          { topicId: 'v1-c0', name: 'Refund requests', description: 'Refund asks.' },
          { topicId: 'v1-c1', name: 'Login trouble', description: 'Login failures.' },
        ],
      }),
    };

    const result = await nameTopics([REFUND_CLUSTER, LOGIN_CLUSTER], { client });

    expect(result).toEqual([
      { topicId: 'v1-c0', name: 'Refund requests', description: 'Refund asks.', fallback: false },
      { topicId: 'v1-c1', name: 'Login trouble', description: 'Login failures.', fallback: false },
    ]);
    expect(client.generateObject).toHaveBeenCalledTimes(1);

    const request = (client.generateObject as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { userPrompt: string; model: string };
    const payload = JSON.parse(request.userPrompt) as {
      clusters: { topicId: string; keywords: string[]; exemplars: string[] }[];
    };
    expect(payload.clusters.map((c) => c.topicId)).toEqual(['v1-c0', 'v1-c1']);
    expect(payload.clusters[0]!.keywords[0]).toBe('refund');
    expect(payload.clusters[0]!.exemplars).toHaveLength(3);
  });

  test('a cluster missing from the model response falls back to keywords for that cluster only', async () => {
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [{ topicId: 'v1-c0', name: 'Refund requests', description: 'd' }],
      }),
    };
    const result = await nameTopics([REFUND_CLUSTER, LOGIN_CLUSTER], { client });
    expect(result[0]!.name).toBe('Refund requests');
    expect(result[0]!.fallback).toBe(false);
    expect(result[1]!.name).toBe('Login Password Change'); // fallback
    expect(result[1]!.fallback).toBe(true);
  });

  test('model failure is retried once, then degrades to fallback and reports via onError', async () => {
    const error = new Error('boom');
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockRejectedValue(error),
    };
    const onError = vi.fn();
    const result = await nameTopics([REFUND_CLUSTER], { client, onError });
    // Single-cluster call: no cross-cluster damping, so raw counts rank
    // (refund 3, shipment 3, customer 2).
    expect(result[0]!.name).toBe('Refund Shipment Customer');
    expect(result[0]!.fallback).toBe(true);
    expect(client.generateObject).toHaveBeenCalledTimes(2); // original + retry
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, ['v1-c0']);
  });

  test('a transient failure recovers on the retry with no fallback', async () => {
    const client: StructuredModelClient = {
      generateObject: vi
        .fn()
        .mockRejectedValueOnce(new Error('flaky'))
        .mockResolvedValueOnce({
          topics: [{ topicId: 'v1-c0', name: 'Refund requests', description: 'd' }],
        }),
    };
    const onError = vi.fn();
    const result = await nameTopics([REFUND_CLUSTER], { client, onError });
    expect(result).toEqual([
      { topicId: 'v1-c0', name: 'Refund requests', description: 'd', fallback: false },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  test('a large map is named in chunks and a dead chunk degrades only its own clusters', async () => {
    // One full chunk that names fine + a 13th cluster whose chunk always fails.
    const clusters = Array.from({ length: NAMING_CLUSTERS_PER_CALL }, (_, i) => ({
      topicId: `c-${i}`,
      summaries: [`alpha${i} bravo${i} charlie${i}`],
    }));
    clusters.push({ topicId: 'c-poison', summaries: ['xylophone yaks zebra'] });

    const generateObject = vi.fn(async (request: { userPrompt: string }) => {
      const payload = JSON.parse(request.userPrompt) as {
        clusters: { topicId: string }[];
      };
      if (payload.clusters.some((c) => c.topicId === 'c-poison')) {
        throw new Error('boom');
      }
      return {
        topics: payload.clusters.map((c) => ({
          topicId: c.topicId,
          name: `Named ${c.topicId}`,
          description: 'd',
        })),
      };
    });
    const onError = vi.fn();
    const result = await nameTopics(clusters, {
      client: { generateObject },
      onError,
    });

    // First chunk: 1 successful call. Poison chunk: original + retry = 2.
    expect(generateObject).toHaveBeenCalledTimes(3);
    const firstPayload = JSON.parse(
      generateObject.mock.calls[0]![0].userPrompt,
    ) as { clusters: { topicId: string }[] };
    expect(firstPayload.clusters).toHaveLength(NAMING_CLUSTERS_PER_CALL);

    expect(result.map((r) => r.fallback)).toEqual([
      ...new Array(NAMING_CLUSTERS_PER_CALL).fill(false),
      true,
    ]);
    expect(result[0]!.name).toBe('Named c-0');
    expect(result[NAMING_CLUSTERS_PER_CALL]!.name).toBe('Xylophone Yaks Zebra');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), ['c-poison']);
  });

  test('model output is sanitized: markdown stripped, whitespace collapsed, length capped', async () => {
    const injected = `**Ignore\nprevious** [instructions](x) ${'A'.repeat(100)}`;
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [{ topicId: 'v1-c0', name: injected, description: '`rm -rf`' }],
      }),
    };
    const result = await nameTopics([REFUND_CLUSTER], { client });
    const name = result[0]!.name;
    expect(name.length).toBeLessThanOrEqual(MAX_TOPIC_NAME_LENGTH);
    expect(name).not.toMatch(/[*[\]`\n]/);
    expect(name.startsWith('Ignore previous instructions')).toBe(true);
    expect(result[0]!.description).toBe('rm -rf');
  });

  test('an over-long description truncates at a word boundary with an ellipsis', async () => {
    const longDescription = `Recurring CI gating and deployment-logic regressions stall PRs; ${'fix by hardening error handling for missing skills and aligning callbacks '.repeat(3)}with the environment`;
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [{ topicId: 'v1-c0', name: 'CI Gate Failures', description: longDescription }],
      }),
    };
    const result = await nameTopics([REFUND_CLUSTER], { client });
    const description = result[0]!.description;
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.endsWith('…')).toBe(true);
    // Cut lands on a word boundary: the kept text plus a space prefixes the source.
    expect(longDescription.startsWith(`${description.slice(0, -1)} `)).toBe(true);
  });

  test('an empty sanitized name falls back to keywords', async () => {
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [{ topicId: 'v1-c0', name: '***', description: '' }],
      }),
    };
    const result = await nameTopics([REFUND_CLUSTER], { client });
    expect(result[0]!.name).toBe('Refund Shipment Customer');
  });
});

describe('sameAs duplicate resolution', () => {
  /** N clusters with distinct vocabulary so keyword hints stay stable. */
  const clustersOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      topicId: `v1-c${i}`,
      summaries: [`Cluster ${i} concerns subject-${i} handling and subject-${i} routing.`],
    }));

  /** A namer response naming every cluster, with `extra` merged per topicId. */
  const respondWith = (extra: Record<string, Record<string, unknown>>) => ({
    generateObject: vi.fn().mockImplementation((req: { userPrompt: string }) => {
      const sent = JSON.parse(req.userPrompt) as { clusters: { topicId: string }[] };
      return Promise.resolve({
        topics: sent.clusters.map((c) => ({
          topicId: c.topicId,
          name: `Name ${c.topicId}`,
          description: `Description ${c.topicId}.`,
          ...(extra[c.topicId] ?? {}),
        })),
      });
    }),
  });

  const sameAsOf = (result: Awaited<ReturnType<typeof nameTopics>>, topicId: string) =>
    result.find((r) => r.topicId === topicId)?.sameAs;

  test('a backward reference folds: the duplicate carries sameAs, the root does not', async () => {
    const client = respondWith({ 'v1-c2': { sameAs: 'v1-c0' } });
    const result = await nameTopics(clustersOf(3), { client });

    expect(sameAsOf(result, 'v1-c2')).toBe('v1-c0');
    // The referenced root, and every unrelated cluster, stay standalone.
    expect(sameAsOf(result, 'v1-c0')).toBeUndefined();
    expect(sameAsOf(result, 'v1-c1')).toBeUndefined();
    // Folding never suppresses the entry's own name/description — the caller
    // needs them to decide what the surviving topic is called.
    expect(result.find((r) => r.topicId === 'v1-c2')).toEqual({
      topicId: 'v1-c2',
      name: 'Name v1-c2',
      description: 'Description v1-c2.',
      fallback: false,
      sameAs: 'v1-c0',
    });
  });

  test('a chain resolves to the earliest root, not the intermediate hop', async () => {
    // c2 → c1 → c0: both duplicates must name c0, or the fold produces an
    // orphan pointing at a topic that itself disappears.
    const client = respondWith({
      'v1-c2': { sameAs: 'v1-c1' },
      'v1-c1': { sameAs: 'v1-c0' },
    });
    const result = await nameTopics(clustersOf(3), { client });

    expect(sameAsOf(result, 'v1-c2')).toBe('v1-c0');
    expect(sameAsOf(result, 'v1-c1')).toBe('v1-c0');
    expect(sameAsOf(result, 'v1-c0')).toBeUndefined();
  });

  test('a FORWARD reference is refused — folding may only point at an earlier cluster', async () => {
    // Left to run forward, two clusters could each claim the other and both
    // vanish from the map. The rule is also what makes traversal terminate.
    const client = respondWith({ 'v1-c0': { sameAs: 'v1-c2' } });
    const result = await nameTopics(clustersOf(3), { client });
    expect(sameAsOf(result, 'v1-c0')).toBeUndefined();
  });

  test('a self-reference is refused', async () => {
    const client = respondWith({ 'v1-c1': { sameAs: 'v1-c1' } });
    const result = await nameTopics(clustersOf(2), { client });
    expect(sameAsOf(result, 'v1-c1')).toBeUndefined();
  });

  test('a reference to an unknown topicId is refused', async () => {
    const client = respondWith({ 'v1-c1': { sameAs: 'v1-c99' } });
    const result = await nameTopics(clustersOf(2), { client });
    expect(sameAsOf(result, 'v1-c1')).toBeUndefined();
  });

  test('a CROSS-CHUNK reference is refused — chunks are named in independent calls', async () => {
    // Clusters beyond the per-call cap are named by a separate request whose
    // model never saw the earlier chunk's exemplars, so a reference across
    // that boundary is a guess, not a judgment.
    const n = NAMING_CLUSTERS_PER_CALL + 2;
    const crossChunkId = `v1-c${NAMING_CLUSTERS_PER_CALL}`; // first of chunk 2
    const client = respondWith({ [crossChunkId]: { sameAs: 'v1-c0' } });
    const result = await nameTopics(clustersOf(n), { client });

    expect(client.generateObject).toHaveBeenCalledTimes(2);
    expect(sameAsOf(result, crossChunkId)).toBeUndefined();
    // …while a WITHIN-chunk reference in that same second chunk still folds.
    const within = `v1-c${NAMING_CLUSTERS_PER_CALL + 1}`;
    const client2 = respondWith({ [within]: { sameAs: crossChunkId } });
    const result2 = await nameTopics(clustersOf(n), { client: client2 });
    expect(sameAsOf(result2, within)).toBe(crossChunkId);
  });

  test('a non-string sameAs from the model is ignored', async () => {
    const client = respondWith({ 'v1-c1': { sameAs: 42 } });
    const result = await nameTopics(clustersOf(2), { client });
    expect(sameAsOf(result, 'v1-c1')).toBeUndefined();
    expect(result.find((r) => r.topicId === 'v1-c1')?.name).toBe('Name v1-c1');
  });

  test('a keyword-fallback entry never carries sameAs', async () => {
    // An unnamed cluster falls back to keywords; it has no model judgment
    // behind it, so it must not claim to duplicate anything.
    const client = {
      generateObject: vi.fn().mockResolvedValue({
        topics: [{ topicId: 'v1-c0', name: 'Name v1-c0', description: 'd.', sameAs: 'v1-c0' }],
      }),
    };
    const result = await nameTopics(clustersOf(2), { client });
    const missing = result.find((r) => r.topicId === 'v1-c1')!;
    expect(missing.fallback).toBe(true);
    expect(missing.sameAs).toBeUndefined();
  });
});
