import { describe, expect, test } from 'vitest';
import { reconcileTopics } from '../topic-reconciler';

const PREV = [
  {
    topicId: 'v1-c0',
    name: 'Refund Requests',
    description: 'User wants a refund for a delayed order.',
    centroid: [1, 0, 0],
  },
  {
    topicId: 'v1-c1',
    name: 'Login Problems',
    description: 'User cannot sign in to their account.',
    centroid: [0, 1, 0],
  },
];

describe('reconcileTopics', () => {
  test('a matching cluster reuses the previous TopicId, name AND description (IDs are the stable identity)', () => {
    const nearRefunds = [0.999, 0.04, 0]; // cosine ≈ 0.999 to v1-c0
    const result = reconcileTopics(
      [{ centroid: nearRefunds, memberIds: ['t1', 't2'] }],
      PREV,
      { mapVersion: 2 },
    );
    // Description carries forward: reconciled topics skip the namer, so
    // losing it here silently blanks the description on every regenerate.
    expect(result).toEqual([
      {
        topicId: 'v1-c0',
        name: 'Refund Requests',
        description: 'User wants a refund for a delayed order.',
        centroid: nearRefunds,
        memberIds: ['t1', 't2'],
        reconciled: true,
      },
    ]);
  });

  test('a matched previous topic without a description carries null (not undefined)', () => {
    const result = reconcileTopics(
      [{ centroid: [0.999, 0.04, 0], memberIds: ['t1'] }],
      [{ topicId: 'v1-c0', name: 'Refund Requests', centroid: [1, 0, 0] }],
      { mapVersion: 2 },
    );
    expect(result[0]!.description).toBeNull();
  });

  test('below-threshold clusters get fresh version-scoped IDs and no name/description', () => {
    const novel = [0, 0, 1];
    const result = reconcileTopics(
      [{ centroid: novel, memberIds: ['t9'] }],
      PREV,
      { mapVersion: 3 },
    );
    expect(result).toEqual([
      {
        topicId: 'v3-c0',
        name: null,
        description: null,
        centroid: novel,
        memberIds: ['t9'],
        reconciled: false,
      },
    ]);
  });

  test('matching is one-to-one: two new clusters near one predecessor — only the closer reuses its ID', () => {
    const closer = [0.999, 0.045, 0];
    const farther = [0.97, 0.24, 0]; // also ≥ 0.9 similarity to v1-c0, but weaker
    const result = reconcileTopics(
      [
        { centroid: farther, memberIds: ['a'] },
        { centroid: closer, memberIds: ['b'] },
      ],
      [PREV[0]!],
      { mapVersion: 2 },
    );

    // Output preserves input order; identity assignment is by best similarity.
    expect(result.map((r) => r.topicId)).toEqual(['v2-c0', 'v1-c0']);
    expect(result.map((r) => r.reconciled)).toEqual([false, true]);
    expect(result[1]!.name).toBe('Refund Requests');
    expect(result[0]!.name).toBeNull();
  });

  test('each previous topic is consumed at most once across many pairs', () => {
    const result = reconcileTopics(
      [
        { centroid: [1, 0, 0], memberIds: ['a'] },
        { centroid: [0.995, 0.1, 0], memberIds: ['b'] },
        { centroid: [0, 1, 0], memberIds: ['c'] },
      ],
      PREV,
      { mapVersion: 4 },
    );
    const reused = result.filter((r) => r.reconciled).map((r) => r.topicId);
    expect(reused.sort()).toEqual(['v1-c0', 'v1-c1']);
    // No duplicate identities in the output.
    expect(new Set(result.map((r) => r.topicId)).size).toBe(3);
  });

  test('custom similarity threshold is honored', () => {
    const borderline = [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]; // sim 0.95 to v1-c0
    const strict = reconcileTopics(
      [{ centroid: borderline, memberIds: ['x'] }],
      PREV,
      { mapVersion: 2, minSimilarity: 0.99 },
    );
    expect(strict[0]!.reconciled).toBe(false);

    const loose = reconcileTopics(
      [{ centroid: borderline, memberIds: ['x'] }],
      PREV,
      { mapVersion: 2, minSimilarity: 0.9 },
    );
    expect(loose[0]!.topicId).toBe('v1-c0');
  });

  test('first generation (no previous map) mints sequential fresh IDs', () => {
    const result = reconcileTopics(
      [
        { centroid: [1, 0, 0], memberIds: ['a'] },
        { centroid: [0, 1, 0], memberIds: ['b'] },
      ],
      [],
      { mapVersion: 1 },
    );
    expect(result.map((r) => r.topicId)).toEqual(['v1-c0', 'v1-c1']);
    expect(result.every((r) => !r.reconciled && r.name === null)).toBe(true);
  });
});

describe('name-carry drift guard', () => {
  const prevWithCount = [
    {
      topicId: 'v1-c48',
      name: 'Citation Verification Quality',
      description: 'Sources located and verified.',
      centroid: [1, 0, 0],
      memberCount: 100,
    },
  ];
  const members = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  test('membership explosion keeps the ID but sends the topic back to the namer', () => {
    // 100 → 301 members (> 3x): the carried label was earned by a membership
    // the topic no longer has. Identity survives; the name does not.
    const result = reconcileTopics(
      [{ centroid: [1, 0, 0], memberIds: members(301) }],
      prevWithCount,
      { mapVersion: 2 },
    );
    expect(result[0]).toEqual({
      topicId: 'v1-c48',
      name: null,
      description: null,
      centroid: [1, 0, 0],
      memberIds: members(301),
      reconciled: true,
    });
  });

  test('membership collapse re-names too — the residual of a split giant', () => {
    const result = reconcileTopics(
      [{ centroid: [1, 0, 0], memberIds: members(33) }], // 33 * 3 < 100
      prevWithCount,
      { mapVersion: 2 },
    );
    expect(result[0]!.reconciled).toBe(true);
    expect(result[0]!.topicId).toBe('v1-c48');
    expect(result[0]!.name).toBeNull();
  });

  test('stable size within 3x carries the name at both boundaries', () => {
    for (const n of [34, 300]) {
      const result = reconcileTopics(
        [{ centroid: [1, 0, 0], memberIds: members(n) }],
        prevWithCount,
        { mapVersion: 2 },
      );
      expect(result[0]!.name).toBe('Citation Verification Quality');
      expect(result[0]!.description).toBe('Sources located and verified.');
    }
    // Exactly AT the shrink bound (34 * 3 == prev 102): 3x-or-less growth is
    // stable — only strictly-past-the-bound drift re-names.
    const atBound = reconcileTopics(
      [{ centroid: [1, 0, 0], memberIds: members(34) }],
      [{ ...prevWithCount[0]!, memberCount: 102 }],
      { mapVersion: 2 },
    );
    expect(atBound[0]!.name).toBe('Citation Verification Quality');
  });

  test('a weak match (similarity in the identity band but under the name band) re-names', () => {
    // cosine([1,0,0], normalize([0.93, 0.37, 0])) ≈ 0.929 — identity carries
    // (≥ 0.9), the name does not (< 0.95).
    const drifted = [0.929, 0.37, 0].map((x, _, arr) => x / Math.hypot(...arr));
    const result = reconcileTopics(
      [{ centroid: drifted, memberIds: members(100) }],
      prevWithCount,
      { mapVersion: 2 },
    );
    expect(result[0]!.topicId).toBe('v1-c48');
    expect(result[0]!.reconciled).toBe(true);
    expect(result[0]!.name).toBeNull();
  });

  test('maps without member counts skip the size check (pre-metric maps)', () => {
    const result = reconcileTopics(
      [{ centroid: [1, 0, 0], memberIds: members(5000) }],
      [{ topicId: 'v1-c0', name: 'Refund Requests', centroid: [1, 0, 0] }],
      { mapVersion: 2 },
    );
    expect(result[0]!.name).toBe('Refund Requests');
  });
});
