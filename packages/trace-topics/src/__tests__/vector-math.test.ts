import { describe, expect, test } from 'vitest';
import {
  cosineDistance,
  cosineSimilarity,
  dot,
  l2Norm,
  l2Normalize,
  normalizedCentroid,
} from '../vector-math';

describe('vector-math', () => {
  test('dot computes the exact inner product', () => {
    expect(dot([1, 2, 3], [4, -5, 6])).toBe(1 * 4 + 2 * -5 + 3 * 6);
  });

  test('dot throws on length mismatch instead of silently zipping', () => {
    expect(() => dot([1, 2], [1, 2, 3])).toThrow('Vector length mismatch: 2 vs 3');
  });

  test('l2Normalize returns a unit vector preserving direction (the Gemini case: unnormalized input)', () => {
    const raw = [3, 0, 4]; // norm 5 — models an unnormalized 1024-D Gemini vector
    const normalized = l2Normalize(raw);
    expect(normalized).toEqual([0.6, 0, 0.8]);
    expect(l2Norm(normalized)).toBeCloseTo(1, 12);
    // input not mutated
    expect(raw).toEqual([3, 0, 4]);
  });

  test('l2Normalize leaves the zero vector unchanged (no NaN poisoning)', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  test('cosineSimilarity is scale-invariant and bounded', () => {
    expect(cosineSimilarity([1, 0], [5, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-2, 0])).toBeCloseTo(-1, 12);
  });

  test('cosineSimilarity against a zero vector is 0, not NaN', () => {
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  test('cosineDistance = 1 - similarity', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 12);
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0, 12);
  });

  test('normalizedCentroid is the unit-length mean', () => {
    // mean of (1,0) and (0,1) is (0.5,0.5) → normalized (√2/2, √2/2)
    const centroid = normalizedCentroid([
      [1, 0],
      [0, 1],
    ]);
    expect(centroid[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(centroid[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(l2Norm(centroid)).toBeCloseTo(1, 12);
  });

  test('normalizedCentroid rejects empty input and mixed dimensions', () => {
    expect(() => normalizedCentroid([])).toThrow(
      'Cannot compute a centroid of zero vectors',
    );
    expect(() => normalizedCentroid([[1, 0], [1, 0, 0]])).toThrow(
      'Vector length mismatch in centroid: 3 vs 2',
    );
  });
});
