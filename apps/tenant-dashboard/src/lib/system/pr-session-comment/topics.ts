import "server-only";

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
 * NEVER be selected here — this data reaches a world-readable PR comment.
 * See `__tests__/topics.test.ts` for the regression test on the SQL string.
 */

/** Minimal ClickHouse seam: one parameterized query returning JSON rows.
 * Same shape as `ChQueryFn` in `pr-session-reconciler/reconciler.ts` —
 * injected so tests exercise this module without a ClickHouse server. */
export type ChQueryFn = (
  sql: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

export interface ReadTopicLabelsInput {
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

  let rows: Record<string, unknown>[];
  try {
    rows = await chQuery(TOPIC_LABELS_SQL, { traceIds });
  } catch (error) {
    // Best-effort: labels arrive on a later comment edit, so a ClickHouse
    // hiccup (or Topics simply being off) must never fail the comment.
    console.error(
      "[pr-session-comment] readTopicLabels query failed; continuing with no labels",
      error,
    );
    return labelsByTrace;
  }

  for (const row of rows) {
    const traceId = typeof row.TraceId === "string" ? row.TraceId : String(row.TraceId ?? "");
    const name = typeof row.Name === "string" ? row.Name : String(row.Name ?? "");
    if (!traceId || !name) continue;
    const existing = labelsByTrace.get(traceId);
    const labels = existing ?? [];
    if (!existing) labelsByTrace.set(traceId, labels);
    if (!labels.includes(name)) labels.push(name);
  }

  return labelsByTrace;
}
