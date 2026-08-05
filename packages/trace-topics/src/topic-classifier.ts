/**
 * Topic classifier — continuous classification against a saved topic map.
 *
 * For each newly embedded
 * facet summary, find the nearest topic centroid (cosine distance, original
 * embedding space — no UMAP transform); assign its TopicId when within the
 * configured threshold, otherwise `no_match`. No model call happens here —
 * this is the ~100ms-per-trace path that keeps topics current between
 * regeneration passes.
 */

import { cosineDistance } from './vector-math';

/** TopicId assigned when no centroid falls within the distance threshold. */
export const NO_MATCH_TOPIC_ID = 'no_match';

/**
 * Default maximum cosine distance for an assignment. Recorded into every
 * topic map's Params at generation time so historical assignments stay
 * interpretable if the default moves.
 */
export const DEFAULT_ASSIGN_MAX_DISTANCE = 0.5;

/** One topic's centroid from the active map. */
export interface TopicCentroid {
  topicId: string;
  /** Unit-length centroid in the original embedding space. */
  centroid: number[];
}

/** Result of classifying one embedding. */
export interface TopicAssignment {
  /** Assigned TopicId, or {@link NO_MATCH_TOPIC_ID}. */
  topicId: string;
  /** Cosine distance to the nearest centroid (even when no_match). */
  distance: number;
}

/**
 * Assign an embedding to the nearest centroid within `maxDistance`.
 *
 * - Empty centroid list → `no_match` at distance 1 (no map to match against).
 * - Ties resolve to the first centroid in list order (deterministic).
 */
export function classifyEmbedding(
  embedding: readonly number[],
  centroids: readonly TopicCentroid[],
  maxDistance: number = DEFAULT_ASSIGN_MAX_DISTANCE,
): TopicAssignment {
  let bestId = NO_MATCH_TOPIC_ID;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const { topicId, centroid } of centroids) {
    const distance = cosineDistance(embedding, centroid);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = topicId;
    }
  }

  if (bestDistance === Number.POSITIVE_INFINITY) {
    return { topicId: NO_MATCH_TOPIC_ID, distance: 1 };
  }
  return bestDistance <= maxDistance
    ? { topicId: bestId, distance: bestDistance }
    : { topicId: NO_MATCH_TOPIC_ID, distance: bestDistance };
}
