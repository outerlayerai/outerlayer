import "server-only";

/**
 * The sessions-list query shape — parsed from `searchParams` by the React Server Component (RSC) page
 * and passed to `AgentSessionsService.listSessions`. Zod-validated the same
 * way any other tenant-scoped read is, minus `appId` (the page resolves that
 * server-side from the URL's `[appName]`, never from the query string).
 */
import { z } from "zod";
import { SESSIONS_PAGE_SIZE, DEFAULT_ORIGIN } from "./session-list-shared";

export { SESSIONS_PAGE_SIZE };

/** Origin token → SQL literal set, shared with the service so the query
 * builder and the validator agree on the closed vocabulary.
 *
 * A Map, not an object literal: the token comes from `?origin=` and keys both
 * the guard and the lookup below. `.has()`/`.get()` answer only for keys the
 * map owns, where `in` and an object index also answer for inherited ones. */
export const ORIGIN_LITERALS: ReadonlyMap<string, string> = new Map([
  ["interactive", "'', 'interactive'"],
  ["agent", "'agent'"],
  ["worker", "'worker'"],
]);

// Internal only — every external caller goes through `parseSessionsUrlParams`
// below, which is the one place UI URL keys become a validated query.
const ListSessionsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(25),
  offset: z.coerce.number().min(0).default(0),
  repo: z.string().optional(),
  branch: z.string().optional(),
  agentType: z.string().optional(),
  /** Exact model id; matches sessions whose Models array contains it. */
  model: z.string().optional(),
  /** Run origin (seat|cloud|ci|shared; '' = pre-migration rows). */
  workerKind: z.string().optional(),
  /** Case-insensitive title substring. */
  q: z.string().max(200).optional(),
  /** Developer filter — the ActorId stamped at ingest (membership id or key:<id>). */
  actor: z.string().optional(),
  /** ISO instant lower/upper bounds on StartedAt. */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["startedAt", "cost", "errors", "turns", "steering", "toolErrorRate"]).default("startedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  /** Trajectory-signal filter — sessions where that signal fired (or `clean`
   * for none). Composes with every other filter, including origin. */
  signal: z.enum(["hands-on", "denied", "tool-errors", "provider-errors", "clean"]).optional(),
  /** "1" to list subagent transcripts as rows; default hides them — a
   * workflow fan-out can put hundreds of children under one session. */
  includeSubagents: z.enum(["1"]).optional(),
  /** Run origin filter — one token or a comma-separated set of
   * interactive|agent|worker; absent lists every origin. `interactive` also
   * matches legacy pre-Origin-column rows (stamped ''). */
  origin: z
    .string()
    .optional()
    .refine((v) => v === undefined || (v.length > 0 && v.split(",").every((t) => ORIGIN_LITERALS.has(t))), {
      message: "origin must be a comma-separated set of interactive|agent|worker",
    }),
  /** Topic drill-down: show only sessions assigned to this topic (by TraceId
   * in trace_facets) for the given facet. Set together; spans repos. */
  topicId: z.string().optional(),
  topicFacet: z.enum(["task", "issues", "steering"]).optional(),
  /** PR filter: show only sessions CONFIRMED-linked (via
   * `pull_request_session`) to this provider PR/MR number. The header link
   * in a rendered PR session comment (`…/sessions?pr=<n>`) is the primary
   * producer of this param. Composes with every other filter. */
  pr: z.coerce.number().int().positive().optional(),
});

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

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
    offset: pageNum * SESSIONS_PAGE_SIZE,
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
    topicId: flat.topicId,
    topicFacet: flat.topicFacet,
    pr: flat.pr,
  });
}
