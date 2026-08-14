import "server-only";

/**
 * The sessions-list query shape — parsed from `searchParams` by the React Server Component (RSC) page
 * and passed to `AgentSessionsService.listSessions`. The Zod schema and the
 * origin-token vocabulary live in `@repo/api-schemas` (shared with the
 * gateway's future `/v1/sessions` route and the `list_sessions` MCP tool);
 * this module owns only the dashboard's URL-vocabulary translation.
 */
import { ListSessionsQuerySchema, MAX_SESSIONS_OFFSET, ORIGIN_LITERALS, type ListSessionsQuery } from "@repo/api-schemas";
import { z } from "zod";
import { SESSIONS_PAGE_SIZE, DEFAULT_ORIGIN } from "./session-list-shared";

export { SESSIONS_PAGE_SIZE };
export type { ListSessionsQuery };

/**
 * Validate `raw` field-by-field against `schema` instead of one whole-object
 * `safeParse` — a single invalid value (a malformed `from`, a stale `sort`
 * token) drops only that field rather than failing the entire parse. The
 * caller of a failing `safeParse` has no way to tell "reject everything" from
 * "reject the one bad field", and falling back to an all-defaults query
 * silently un-filters the page for every OTHER, perfectly valid field the
 * caller sent. Omitted/undefined keys are left for the schema's own
 * `.default(...)`/`.optional()` to resolve.
 */
function salvageParse<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  raw: Record<string, unknown>,
): z.infer<z.ZodObject<Shape>> {
  const salvaged: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    if (!(key in raw) || raw[key] === undefined) continue;
    const result = (fieldSchema as z.ZodTypeAny).safeParse(raw[key]);
    if (result.success) salvaged[key] = result.data;
  }
  return schema.parse(salvaged);
}

/**
 * topicId/topicFacet are a matched pair — `ListSessionsQuerySchema` refines
 * that one is set iff the other is. Per-field salvage (above) has no
 * concept of a pair: it would keep whichever half survives and drop the
 * other, then hand `schema.parse` a lone half that fails the refine. This
 * resolves the pair BEFORE that per-field loop, using the same field
 * schemas the loop would use — either both raw values individually
 * validate and both survive, or neither is forwarded, so an invalid OR a
 * missing half drops the whole topic filter rather than throwing.
 */
function salvageTopicPair(
  rawTopicId: string | undefined,
  rawTopicFacet: string | undefined,
): { topicId?: string; topicFacet?: string } {
  const topicIdResult =
    rawTopicId === undefined ? undefined : ListSessionsQuerySchema.shape.topicId.safeParse(rawTopicId);
  const topicFacetResult =
    rawTopicFacet === undefined ? undefined : ListSessionsQuerySchema.shape.topicFacet.safeParse(rawTopicFacet);
  if (topicIdResult?.success && topicFacetResult?.success) {
    return { topicId: topicIdResult.data, topicFacet: topicFacetResult.data };
  }
  return {};
}

/**
 * The list's URL vocabulary → the service's `ListSessionsQuery` shape. The
 * URL uses short, human filter-bar keys (`agent`/`developer`/`source`, a
 * 0-based `page`) the service schema does not share (`agentType`/`actor`/
 * `workerKind`, an `offset`) — this is the ONE place that translates one to
 * the other. `agent-sessions.tsx` (the client) and this parser must never
 * drift on a field name or a defaulting rule, because a mismatch silently
 * drops a filter rather than erroring: every UI key this function does not
 * name is a key the server never sees.
 *
 * `topicActive` mirrors the client's own `Boolean(topicId && topicFacet)` —
 * the caller (the page RSC) computes it from the same two params so the two
 * "what does an absent origin mean" answers can never disagree.
 */
export function parseSessionsUrlParams(
  flat: Record<string, string>,
  topicActive: boolean,
): ListSessionsQuery {
  const pageNum = Math.max(0, Number(flat.page ?? 0) || 0);
  // Clamp to the schema's offset ceiling rather than letting salvageParse
  // drop an over-deep offset: the drop would silently render page 1 under a
  // deep page's URL, where the clamp shows the deepest reachable page.
  const offset = Math.min(pageNum * SESSIONS_PAGE_SIZE, MAX_SESSIONS_OFFSET);

  // A topic drill-down's pristine state is every origin (the drill-down's
  // own facet rules narrow the population); the plain list's pristine state
  // is the People segment. "all" is the client's explicit every-origin
  // choice — encoded as an absent filter, never a literal the schema (which
  // only accepts interactive|agent|worker tokens) would reject. Mirrors the
  // client's own `asOrigin(v, dflt)` exactly: a malformed/unrecognized token
  // falls back to the default segment, same as an absent one — it must NOT
  // fall through to salvageParse's generic drop, which would resolve to
  // "every origin" instead of the intended default.
  const defaultOrigin = topicActive ? "" : DEFAULT_ORIGIN;
  const isValidOriginToken = (v: string) =>
    v.length > 0 && v.split(",").every((t) => ORIGIN_LITERALS.has(t));
  const rawOrigin =
    flat.origin === "all" ? ""
    : flat.origin === undefined ? defaultOrigin
    : isValidOriginToken(flat.origin) ? flat.origin
    : defaultOrigin;

  return salvageParse(ListSessionsQuerySchema, {
    limit: SESSIONS_PAGE_SIZE,
    offset,
    branch: flat.branch,
    agentType: flat.agent,
    model: flat.model,
    workerKind: flat.source,
    q: flat.q,
    actor: flat.developer,
    from: flat.from,
    to: flat.to,
    sort: flat.sort,
    dir: flat.dir,
    signal: flat.signal,
    includeSubagents: flat.includeSubagents,
    origin: rawOrigin || undefined,
    ...salvageTopicPair(flat.topicId, flat.topicFacet),
    pr: flat.pr,
  });
}
