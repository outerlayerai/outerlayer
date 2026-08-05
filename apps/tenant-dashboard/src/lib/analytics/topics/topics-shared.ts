/**
 * Client-safe Topics contracts — types + constants shared by the server-side
 * TopicsService and the client-side Topics page/hook (and by other domains,
 * such as the agent-sessions drill-down, that round-trip a topic facet
 * through the URL). Deliberately NO 'server-only' import and no server
 * dependencies.
 */

import type { CaptureTier } from '@outerlayer/session-schema';

/** Facets that have topic maps (sentiment is an enum, not clustered). */
export const TOPIC_FACETS = ['task', 'issues', 'steering'] as const;
export type TopicFacet = (typeof TOPIC_FACETS)[number];

/**
 * Parse an untrusted facet string (URL param) against the canonical facet
 * list. Every surface that round-trips a facet through a URL must use this —
 * a hand-maintained subset silently drops whichever facet it forgot, and the
 * drill-down then renders an UNFILTERED list that looks exactly like a
 * filtered one (this happened to steering).
 */
export function parseTopicFacet(raw: string | null | undefined): TopicFacet | undefined {
  return (TOPIC_FACETS as readonly string[]).includes(raw ?? '')
    ? (raw as TopicFacet)
    : undefined;
}

/** Cold-start floor for the batched facets (task, issues). */
export const MIN_SUMMARIES_FOR_GENERATION = 100;

/**
 * Steering's own floor. Steering is triple-filtered relative to the batched
 * facets — full-tier capture only, interactive (non-agent) sessions only, and
 * only rule/preference corrections carry embeddings — so on identical traffic
 * its clusterable corpus runs one to two orders of magnitude thinner than
 * task/issues. The clusterer resolves dense groups from ~5 members, so 25
 * rows is enough to surface a handful of genuine conventions; holding
 * steering to the batched floor freezes a stale map in place with the
 * Regenerate action permanently disabled.
 */
export const MIN_STEERING_SUMMARIES_FOR_GENERATION = 25;

/** The generation floor for one facet (before any env override). */
export function generationFloorForFacet(facet: TopicFacet): number {
  return facet === 'steering'
    ? MIN_STEERING_SUMMARIES_FOR_GENERATION
    : MIN_SUMMARIES_FOR_GENERATION;
}

interface TopicListEntry {
  topicId: string;
  name: string;
  description: string;
  /**
   * Live count of distinct ROOT sessions assigned to this topic on the active
   * map. A subagent transcript credits its parent session, so a workflow that
   * fans out N children counts once — the number a user sees here matches the
   * sessions the drill-down lists.
   */
  sessionCount: number;
  /** Share of classified sessions (assigned + no_match) in [0, 1]. */
  share: number;
  /**
   * Per-topic outcome metrics — snapshots computed at generation over the
   * sampled member traces (as of {@link TopicsList.generatedAt}), NOT live:
   * traces the enrichment cron classifies after generation don't move them
   * until the next generation. Maps generated before the metric columns
   * existed (ClickHouse migration 24) read as zeros.
   *
   * Cost covers the session's OWN generation spans only; a subagent's spend
   * lives on its own transcript, which the session count folds into the
   * parent but this figure does not. Duration is wall-clock lifetime — first
   * to last span, idle included — not responsiveness.
   */
  avgLatencyMs: number;
  avgCostUsd: number;
  /** Session count per trend bucket, aligned to {@link TopicsList.trendDays}. */
  trend: number[];
}

export interface TopicsList {
  facet: TopicFacet;
  mapVersion: number;
  generatedAt: string | null;
  topics: TopicListEntry[];
  /** Distinct root sessions classified no_match on the active map. */
  noMatchCount: number;
  /**
   * Facet summaries a generation pass would sample RIGHT NOW — ok status,
   * embedded in the active dimension, minus the subagent/agent-origin
   * transcripts task and steering refuse to cluster. Computed by the same
   * predicate generation's floor check runs, so the cold-start progress and
   * the Generate gate never promise a map generation then refuses. Marker
   * rows (checked, nothing found) and embedding-degraded rows are likewise
   * excluded: they can never be sampled.
   */
  samplableCount: number;
  /**
   * The generation floor in effect server-side (the default, or the
   * TOPICS_MIN_SUMMARIES override) — the denominator the cold-start progress
   * renders against.
   */
  required: number;
  /**
   * Bucket labels (oldest→newest) for the topics-over-time trend x-axis, as
   * "YYYY-MM-DD HH:00:00" (UTC). Anchored to the data's own span, so a
   * backfilled corpus that ended weeks ago still has an axis.
   */
  trendDays: string[];
  /** No-match count per bucket, aligned to {@link TopicsList.trendDays}. */
  noMatchTrend: number[];
  /**
   * Granularity of {@link TopicsList.trendDays} — 'hour' when the data spans a
   * couple of days, 'day' once it's wider. Drives the x-axis label format.
   */
  trendBucket: 'hour' | 'day';
  /**
   * The tenant's capture-tier ceiling, present only on the `steering` facet
   * (the page reads it to explain an empty Steering tab). Steering mines
   * `turns[].text`, which is `full`-tier only — so a tenant below `full` never
   * gets steering rows and would otherwise see a silent empty table. Omitted
   * for the task/issues facets, which don't depend on message text.
   */
  captureTier?: CaptureTier;
}

export type GenerateOutcome =
  | {
      status: 'generated';
      facet: TopicFacet;
      mapVersion: number;
      topicCount: number;
      sampleSize: number;
      noiseCount: number;
      mode: string;
      generationMs: number;
    }
  | {
      status: 'not_enough_data';
      facet: TopicFacet;
      sampleSize: number;
      required: number;
    }
  | {
      // Clustering ran but produced no cluster (everything is noise). We keep
      // the previous map intact rather than writing an empty one and rewriting
      // every summary to no_match.
      status: 'no_clusters';
      facet: TopicFacet;
      sampleSize: number;
    };
