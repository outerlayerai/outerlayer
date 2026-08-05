import { describe, expect, test } from 'vitest';
import { NO_MATCH_TOPIC_ID, classifyEmbedding } from '../topic-classifier';

const CENTROIDS = [
  { topicId: 'refunds', centroid: [1, 0, 0] },
  { topicId: 'logins', centroid: [0, 1, 0] },
];

describe('classifyEmbedding', () => {
  test('assigns the nearest centroid with its exact cosine distance', () => {
    // 30° from refunds (distance ≈ 0.134), 60° from logins (distance 0.5)
    const embedding = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0];
    const result = classifyEmbedding(embedding, CENTROIDS);
    expect(result.topicId).toBe('refunds');
    expect(result.distance).toBeCloseTo(1 - Math.cos(Math.PI / 6), 12);
  });

  test('returns no_match with the nearest distance when outside the threshold', () => {
    const embedding = [0, 0, 1]; // orthogonal to both centroids → distance 1
    const result = classifyEmbedding(embedding, CENTROIDS);
    expect(result).toEqual({ topicId: NO_MATCH_TOPIC_ID, distance: 1 });
  });

  test('a custom threshold changes the assignment boundary', () => {
    const embedding = [Math.SQRT1_2, Math.SQRT1_2, 0]; // distance ≈ 0.293 to both
    const strict = classifyEmbedding(embedding, CENTROIDS, 0.1);
    expect(strict.topicId).toBe(NO_MATCH_TOPIC_ID);

    const loose = classifyEmbedding(embedding, CENTROIDS, 0.3);
    expect(loose.topicId).toBe('refunds'); // tie resolves to first in list order
    expect(loose.distance).toBeCloseTo(1 - Math.SQRT1_2, 12);
  });

  test('no LLM, no map: empty centroid list is no_match at distance 1', () => {
    expect(classifyEmbedding([1, 0, 0], [])).toEqual({
      topicId: NO_MATCH_TOPIC_ID,
      distance: 1,
    });
  });

  test('exactly at the threshold still assigns (<= boundary, not <)', () => {
    const centroids = [{ topicId: 't', centroid: [1, 0] }];
    const embedding = [Math.SQRT1_2, Math.SQRT1_2];
    // Pin the boundary semantics without floating-point guesswork: classify
    // with maxDistance set to the embedding's own computed distance.
    const { distance } = classifyEmbedding(embedding, centroids, 2);
    const atBoundary = classifyEmbedding(embedding, centroids, distance);
    expect(atBoundary).toEqual({ topicId: 't', distance });
    // And one ulp below the boundary rejects.
    const below = classifyEmbedding(
      embedding,
      centroids,
      distance - Number.EPSILON,
    );
    expect(below.topicId).toBe('no_match');
  });
});
