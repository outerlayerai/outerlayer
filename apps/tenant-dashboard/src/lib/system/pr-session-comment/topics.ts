import "server-only";

import { serverLogger } from "@/lib/observability/server-logger";

/**
 * Topic labels for the PR session comment.
 *
 * ClickHouse `trace_facets` (one row per extracted facet — task, issues,
 * steering, and any custom facet a tenant adds) is joined to
 * `trace_topic_maps` on `TopicId` for the human-readable topic `Name`,
 * restricted to each (AppId, Environment, Facet) group's LATEST `MapVersion`
 * — an older version's assignments describe a superseded map and would mix
 * stale names in with current ones. **Every facet is included, built-in and
 * custom** — the comment doesn't get to decide which facets matter, the
 * tenant's Topics configuration already did.
 *
 * This is best-effort by design: topic labels are a later-edit enrichment
 * (see the plan's debounced-queue section), so a trace with no facets yet,
 * a tenant with Topics off, or a query failure must all degrade to "no
 * labels" — never throw and never block the rest of the comment.
 *
 * PRIVACY: `trace_facets.Summary` is transcript-derived free text and must
 * NEVER reach a caller — this data ends up in a world-readable PR comment,
 * and AC-057-08 turns on that. The SELECT list is the first line of defense
 * and `__tests__/topics.test.ts` string-matches it, but a string match dies
 * the moment someone reformats the query or moves to a builder. The
 * STRUCTURAL guarantee is {@link projectTopicRow}: every row crosses into
 * this module through an explicit two-field allowlist, so a column added to
 * the SQL — deliberately or by accident — cannot reach the renderer.
 */

/** Minimal ClickHouse seam: one parameterized query returning JSON rows.
 * Same shape as `ChQueryFn` in `pr-session-reconciler/reconciler.ts` —
 * injected so tests exercise this module without a ClickHouse server. */
export type ChQueryFn = (
  sql: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

interface ReadTopicLabelsInput {
  /** Null when ClickHouse is unconfigured — treated as "no labels". */
  chQuery: ChQueryFn | null;
  traceIds: string[];
}

/**
 * `trace_facets` rows for the requested traces, restricted to `Status =
 * 'ok'` (a checked-but-errored extraction has no meaningful label),
 * `IsDeleted = 0`, and each row's own (AppId, Environment, Facet) group's
 * latest `MapVersion` (the `latest_map_versions` CTE) — computed generically
 * over every facet rather than one hardcoded name, joined back to
 * `trace_topic_maps` for the topic `Name`. Deliberately omits
 * `trace_facets.Summary` (transcript-derived; must never render) and
 * `trace_facets.Label` (the raw per-row label — the topic `Name` is the
 * stable, human-curated one).
 */
const TOPIC_LABELS_SQL = `
WITH latest_map_versions AS (
  SELECT AppId, Environment, Facet, max(MapVersion) AS MapVersion
  FROM trace_topic_maps FINAL
  WHERE IsDeleted = 0
  GROUP BY AppId, Environment, Facet
)
SELECT
  tf.TraceId AS TraceId,
  ttm.Name AS Name
FROM trace_facets AS tf FINAL
INNER JOIN latest_map_versions AS lmv
  ON tf.AppId = lmv.AppId
  AND tf.Environment = lmv.Environment
  AND tf.Facet = lmv.Facet
  AND tf.MapVersion = lmv.MapVersion
INNER JOIN trace_topic_maps AS ttm FINAL
  ON ttm.AppId = tf.AppId
  AND ttm.Environment = tf.Environment
  AND ttm.Facet = tf.Facet
  AND ttm.MapVersion = tf.MapVersion
  AND ttm.TopicId = tf.TopicId
WHERE tf.TraceId IN {traceIds:Array(String)}
  AND tf.IsDeleted = 0
  AND tf.Status = 'ok'
  AND ttm.IsDeleted = 0
`;

/**
 * The ONLY two fields of a `trace_facets` row this feature is allowed to
 * see. Named as a type so the allowlist is a declaration, not a convention.
 */
interface TopicLabelRow {
  TraceId: string;
  Name: string;
}

/**
 * Projects one raw ClickHouse row onto {@link TopicLabelRow}, dropping every
 * other column — `Summary` above all, which is transcript-derived and must
 * never render (AC-057-08).
 *
 * This is the privacy boundary in code rather than in a docstring: the raw
 * `Record<string, unknown>` from the query never leaves this function, so
 * whatever the SQL selects, only `TraceId` and `Name` can travel onward.
 * Returns `null` for a row missing either field — an unusable label, not a
 * reason to fail the comment.
 */
function projectTopicRow(row: Record<string, unknown>): TopicLabelRow | null {
  const traceId = typeof row.TraceId === "string" ? row.TraceId : String(row.TraceId ?? "");
  const name = typeof row.Name === "string" ? row.Name : String(row.Name ?? "");
  if (!traceId || !name) return null;
  return { TraceId: traceId, Name: name };
}

/**
 * Reads topic labels for a set of traces, keyed by `TraceId`, deduped and in
 * first-seen (stable) order. Every requested trace id is present in the
 * returned map — traces with no facets, an unconfigured ClickHouse client,
 * an empty input, or a failed query all resolve to `[]` rather than a
 * missing key, so callers never need a fallback at the read site.
 */
export async function readTopicLabels({
  chQuery,
  traceIds,
}: ReadTopicLabelsInput): Promise<Map<string, string[]>> {
  const labelsByTrace = new Map<string, string[]>(traceIds.map((id) => [id, []]));
  if (!chQuery || traceIds.length === 0) return labelsByTrace;

  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await chQuery(TOPIC_LABELS_SQL, { traceIds });
  } catch (error) {
    // Best-effort: labels arrive on a later comment edit, so a ClickHouse
    // hiccup (or Topics simply being off) must never fail the comment.
    //
    // Routed through `serverLogger` (not `console.error`, which never leaves
    // the container) for the same reason as `refresh.ts`'s not-permitted
    // event: a persistently broken query degrades labels to blank, which is
    // INDISTINGUISHABLE from Topics being off or not yet clustered. Nothing
    // else would ever surface it. Structured and metric-tagged so it's
    // gettable in Logtail by name.
    await serverLogger.error(error instanceof Error ? error : new Error(String(error)), {
      context: "[pr-session-comment] readTopicLabels query failed; continuing with no labels",
      event: "pr_session_comment.topics_query_failed",
      _metric: true,
      metric_name: "pr_session_comment.topics_query_failed",
      metric_value: 1,
      traceCount: traceIds.length,
    });
    return labelsByTrace;
  }

  for (const raw of rawRows) {
    const row = projectTopicRow(raw);
    if (!row) continue;
    const existing = labelsByTrace.get(row.TraceId);
    const labels = existing ?? [];
    if (!existing) labelsByTrace.set(row.TraceId, labels);
    if (!labels.includes(row.Name)) labels.push(row.Name);
  }

  return labelsByTrace;
}
