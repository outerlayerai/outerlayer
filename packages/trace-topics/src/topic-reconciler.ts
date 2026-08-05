/**
 * Topic reconciliation — stable TopicIds across regeneration runs.
 *
 * HDBSCAN cluster numbering is not stable run-to-run, so a fresh map's
 * cluster 3 may be last week's cluster 7. To reconcile,
 * match each new cluster to the previous map's topics by centroid cosine
 * similarity; matches at or above the threshold REUSE the prior TopicId (and
 * keep the prior name — names are disposable labels, IDs are the durable
 * identity). Unmatched clusters get fresh version-scoped IDs.
 *
 * Matching is greedy one-to-one on descending similarity: the strongest
 * (new, previous) pair wins first, and each side is consumed at most once —
 * two new clusters can never both claim one predecessor.
 */

import { cosineSimilarity } from './vector-math';

/** Similarity floor for treating a new cluster as a prior topic. */
export const DEFAULT_RECONCILE_MIN_SIMILARITY = 0.9;

/**
 * Similarity floor for carrying the prior NAME along with the identity. The
 * match floor above is deliberately loose (identity should survive ordinary
 * regeneration wobble), but a name is a claim about the members — a cluster
 * that barely cleared the match floor has drifted enough that its prior label
 * may describe none of its current members.
 */
export const NAME_CARRY_MIN_SIMILARITY = 0.95;

/**
 * Size-change factor beyond which a carried topic is re-named. A mega-cluster
 * sits near the manifold's center of mass, so its centroid drifts slowly and
 * it keeps clearing the similarity floors while absorbing everything around
 * it. A topic named over 40 members that now holds thousands wears a label
 * earned by a membership it no longer has, and the name can end up describing
 * almost none of what it contains. Growth or shrink past this factor sends the
 * topic back to the namer; the ID still carries.
 */
export const NAME_CARRY_MAX_GROWTH = 3;

/** A cluster fresh out of generation, pre-identity. */
export interface UnreconciledCluster {
  /** Unit-length centroid in the original embedding space. */
  centroid: number[];
  /** Member facet-row keys (trace ids). */
  memberIds: string[];
}

/** A topic from the previous map version. */
export interface PreviousTopic {
  topicId: string;
  name: string;
  /** Prior one-line description; carried forward alongside the name. */
  description?: string;
  centroid: number[];
  /**
   * Member count of the previous map version — the size-drift signal for the
   * name-carry guard. Absent or 0 (maps predating the metric columns) skips
   * the size check; the similarity check still applies.
   */
  memberCount?: number;
}

/** A cluster with settled identity. */
export interface ReconciledTopic {
  topicId: string;
  /** Carried-forward name for reconciled topics; null → needs naming. */
  name: string | null;
  /**
   * Carried-forward description for reconciled topics; null → needs naming.
   * Reconciled topics skip the LLM namer, so without carrying this the prior
   * description would be lost on every regenerate.
   */
  description: string | null;
  centroid: number[];
  memberIds: string[];
  /** True when this topic reused a previous TopicId. */
  reconciled: boolean;
}

/**
 * Settle identities for a new generation's clusters against the previous map.
 *
 * @param clusters - New clusters (any order; order is preserved in output).
 * @param previousTopics - Topics of the previous map version ([] on first run).
 * @param options.mapVersion - Version being generated; used in fresh IDs
 *   (`v{mapVersion}-c{index}`) so IDs are unique across a scope's history.
 * @param options.minSimilarity - Reuse threshold; defaults to
 *   {@link DEFAULT_RECONCILE_MIN_SIMILARITY}.
 */
export function reconcileTopics(
  clusters: readonly UnreconciledCluster[],
  previousTopics: readonly PreviousTopic[],
  options: { mapVersion: number; minSimilarity?: number },
): ReconciledTopic[] {
  const minSimilarity =
    options.minSimilarity ?? DEFAULT_RECONCILE_MIN_SIMILARITY;

  // All cross pairs at/above threshold, strongest first. Deterministic
  // tie-break by (new index, previous index) keeps runs reproducible.
  const pairs: { clusterIndex: number; prevIndex: number; similarity: number }[] = [];
  for (let ci = 0; ci < clusters.length; ci++) {
    for (let pi = 0; pi < previousTopics.length; pi++) {
      const similarity = cosineSimilarity(
        (clusters[ci] as UnreconciledCluster).centroid,
        (previousTopics[pi] as PreviousTopic).centroid,
      );
      if (similarity >= minSimilarity) {
        pairs.push({ clusterIndex: ci, prevIndex: pi, similarity });
      }
    }
  }
  pairs.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.clusterIndex - b.clusterIndex ||
      a.prevIndex - b.prevIndex,
  );

  const matchedByCluster = new Map<
    number,
    { previous: PreviousTopic; similarity: number }
  >();
  const consumedPrev = new Set<number>();
  for (const { clusterIndex, prevIndex, similarity } of pairs) {
    if (matchedByCluster.has(clusterIndex) || consumedPrev.has(prevIndex)) {
      continue;
    }
    matchedByCluster.set(clusterIndex, {
      previous: previousTopics[prevIndex] as PreviousTopic,
      similarity,
    });
    consumedPrev.add(prevIndex);
  }

  return clusters.map((cluster, index) => {
    const match = matchedByCluster.get(index);
    if (match) {
      // Identity always carries; the NAME must still fit. A weak match or a
      // membership that exploded/collapsed sends the topic back to the namer
      // (name null → the caller names it from centroid-core exemplars), so a
      // drifted cluster can never keep wearing a label its members outgrew.
      const prevCount = match.previous.memberCount ?? 0;
      const sizeDrifted =
        prevCount > 0 &&
        (cluster.memberIds.length > prevCount * NAME_CARRY_MAX_GROWTH ||
          cluster.memberIds.length * NAME_CARRY_MAX_GROWTH < prevCount);
      const nameFits =
        match.similarity >= NAME_CARRY_MIN_SIMILARITY && !sizeDrifted;
      return {
        topicId: match.previous.topicId,
        name: nameFits ? match.previous.name : null,
        description: nameFits ? (match.previous.description ?? null) : null,
        centroid: cluster.centroid,
        memberIds: cluster.memberIds,
        reconciled: true,
      };
    }
    return {
      topicId: `v${options.mapVersion}-c${index}`,
      name: null,
      description: null,
      centroid: cluster.centroid,
      memberIds: cluster.memberIds,
      reconciled: false,
    };
  });
}
