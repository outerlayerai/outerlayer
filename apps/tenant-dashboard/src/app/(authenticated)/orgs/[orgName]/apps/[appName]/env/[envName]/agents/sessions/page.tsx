import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { resolveAgentSessionsContext } from "@/features/agent-sessions/request-context";
import { agentSessionsService } from "@/features/agent-sessions/service";
import { parseSessionsUrlParams } from "@/features/agent-sessions/list-query";
import { AgentSessions } from "@/features/agent-sessions/components/agent-sessions";
import { TIME_RANGES } from "@/features/agent-sessions/session-list-shared";
import { listSavedFilters } from "@/lib/analytics/saved-filters/read";

type SearchParams = Record<string, string | string[] | undefined>;

function flatten(searchParams: SearchParams): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") flat[key] = value;
  }
  return flat;
}

/**
 * The lifted `listSessions` defaults its own scan to a trailing 30 days when
 * `from` is absent (a REST/MCP caller with no explicit window shouldn't scan
 * whole history) — this page's "All time" preset must stay "all time" against
 * that default, so it sends an explicit lower bound predating the product
 * instead of leaving `from` unset.
 */
const ALL_TIME_FROM = "1970-01-01T00:00:00.000Z";

/** `from` derives from the `range` preset at request time (not a
 * client-computed, possibly-stale `Date.now()`), looked up against the same
 * range table the filter bar renders so the two never drift apart. A plain
 * helper (not inlined in the component body) — `Date.now()` is fine at
 * request time but the render-purity lint can't tell a React Server Component (RSC)'s per-request
 * render from a client re-render, so it stays out of JSX-returning code. */
function resolveFrom(rangeKey: string | undefined, explicitFrom: string | undefined): string {
  const hours = TIME_RANGES.find((r) => r.key === (rangeKey ?? ""))?.hours ?? 0;
  return hours ? new Date(Date.now() - hours * 3600_000).toISOString() : (explicitFrom ?? ALL_TIME_FROM);
}

async function SessionsList({
  appName,
  envName,
  searchParams,
}: {
  appName: string;
  envName: string;
  searchParams: SearchParams;
}) {
  const ctx = await resolveAgentSessionsContext(appName);
  if (!ctx) notFound();

  const flat = flatten(searchParams);
  // Mirrors the client's own `Boolean(topicId && topicFacet)` — the two
  // "what does an absent origin mean" defaults must agree.
  const topicActive = Boolean(flat.topicId && flat.topicFacet);
  const query = parseSessionsUrlParams(flat, topicActive);

  const from = resolveFrom(flat.range, query.from);

  // Saved views are seeded alongside the session list — a page RSC injects
  // both reads, so `AgentSessions` never re-fetches the view list itself.
  const [data, savedFilters] = await Promise.all([
    agentSessionsService.listSessions(ctx, { ...query, from }),
    listSavedFilters(ctx.db, { appId: ctx.appId, page: "agents-sessions" }),
  ]);
  return <AgentSessions data={data} appId={ctx.appId} envName={envName} savedFilters={savedFilters} />;
}

export default async function AgentSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ appName: string; envName: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ appName, envName }, sp] = await Promise.all([params, searchParams]);
  // A distinct key per param set so a filter/sort/page navigation suspends
  // this boundary specifically — combined with the client's `useTransition`
  // around the navigation, React keeps the previous rows visible (no
  // fallback flash) until the new page is ready, then swaps atomically.
  const paramsKey = new URLSearchParams(flatten(sp)).toString();

  return (
    <Suspense
      key={paramsKey}
      fallback={<PageSkeleton variant="table-page" data-testid="sessions-skeleton" />}
    >
      <SessionsList appName={appName} envName={envName} searchParams={sp} />
    </Suspense>
  );
}
