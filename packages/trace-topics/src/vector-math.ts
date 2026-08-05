/**
 * Vector math for the Trace Topics pipeline.
 *
 * Pure, dependency-free helpers shared by Stage 3 normalization, the
 * nearest-centroid classifier, and topic-map reconciliation.
 *
 * All functions treat vectors as plain number[] and never mutate inputs.
 */

/** Dot product. Throws when lengths differ — a silent zip would hide bugs. */
export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: ${a.length} vs ${b.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

/** Euclidean (L2) norm. */
export function l2Norm(v: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/**
 * Return a unit-length copy of `v`.
 *
 * Gemini embeddings at non-3072 dimensions are NOT normalized by the API
 * ("you must manually normalize non-3072 dimensions" — Google docs), and the
 * centroid math in classification/reconciliation assumes unit vectors, so
 * Stage 3 must route every stored embedding through this.
 *
 * A zero vector is returned unchanged (there is no direction to preserve;
 * callers treat it as "no signal").
 */
export function l2Normalize(v: readonly number[]): number[] {
  const norm = l2Norm(v);
  if (norm === 0) return [...v];
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = (v[i] as number) / norm;
  }
  return out;
}

/**
 * Cosine similarity in [-1, 1]. Zero vectors have no direction; similarity
 * against them is defined as 0 (maximally dissimilar for our purposes).
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const na = l2Norm(a);
  const nb = l2Norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Cosine distance = 1 − cosine similarity. Range [0, 2]. */
export function cosineDistance(
  a: readonly number[],
  b: readonly number[],
): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Normalized mean of a set of vectors — the topic-centroid operation:
 * centroid = l2Normalize(mean(members)).
 *
 * Throws on an empty set or mixed dimensions: a centroid of nothing is a
 * caller bug, not a value.
 */
export function normalizedCentroid(vectors: readonly (readonly number[])[]): number[] {
  const first = vectors[0];
  if (!first) {
    throw new Error('Cannot compute a centroid of zero vectors');
  }
  const dim = first.length;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(
        `Vector length mismatch in centroid: ${v.length} vs ${dim}`,
      );
    }
    for (let i = 0; i < dim; i++) {
      mean[i] = (mean[i] as number) + (v[i] as number);
    }
  }
  for (let i = 0; i < dim; i++) {
    mean[i] = (mean[i] as number) / vectors.length;
  }
  return l2Normalize(mean);
}
