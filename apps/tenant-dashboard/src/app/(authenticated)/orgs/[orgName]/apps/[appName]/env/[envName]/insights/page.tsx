import { Suspense } from "react";
import { AnalyticsError } from "@repo/observability-service";
import { PageSkeleton } from "@/components/page-skeleton";
import { getAppIdByName } from "@/utils/get-app-id";
import { Topics } from "@/features/topics";
import { loadTopicsForApp } from "@/features/topics/read";
import {
  parseTopicFacet,
  type TopicFacet,
  type TopicsList,
} from "@/lib/analytics/topics/topics-shared";

// Generation clusters (seconds at current scale); the `generateTopics` server
// action inherits this page's `maxDuration` (Server Actions inherit the
// invoking page's segment config), matching the deleted route's budget. 300s
// sits within the deploy platform's function-duration cap for this
// project — `pr-session-reconcile`'s cron route already runs at the same
// `maxDuration = 300` in production (registered in vercel.json), so the
// budget is a proven ceiling here, not an untested one.
export const maxDuration = 300;

async function TopicsContent({ appId, facet }: { appId: string; facet: TopicFacet }) {
  // Resolved in the try/catch, then rendered once outside it — constructing
  // JSX inside a try/catch can't actually catch a child's render errors, only
  // errors thrown while building the element tree here.
  let topics: TopicsList | null = null;
  let error: { message: string; status?: number } | null = null;
  try {
    topics = await loadTopicsForApp(appId, facet);
  } catch (err) {
    error = {
      message: err instanceof Error ? err.message : "Failed to load topics",
      status: err instanceof AnalyticsError ? err.statusCode : undefined,
    };
  }
  return <Topics appId={appId} facet={facet} topics={topics} error={error} />;
}

export default async function TopicsPage({
  params,
  searchParams,
}: {
  params: Promise<{ appName: string }>;
  searchParams: Promise<{ facet?: string }>;
}) {
  const { appName } = await params;
  const { facet: facetParam } = await searchParams;
  const facet = parseTopicFacet(facetParam) ?? "task";

  // RLS-scoped lookup: resolves only apps the caller can read, so an app in
  // another tenant that happens to share the name can never be selected.
  const appId = await getAppIdByName(appName);
  if (!appId) return null;

  return (
    // Keyed by facet: a switch is a real navigation (the map is re-read for
    // the new facet), so the fallback shows again and the card below remounts
    // with clean generate/outcome state rather than carrying the previous
    // facet's transient UI state across.
    // The page header renders inside the suspended child, so the placeholder
    // brings its own header block.
    // No filter bar and no pager on this table, so neither is reserved — a
    // placeholder that promises furniture the page lacks reflows on exactly
    // the axis it exists to hold still. The trend chart above the table is
    // likewise not reserved: it mounts client-side after hydration, so no
    // server-rendered placeholder can hold its room.
    <Suspense
      key={facet}
      fallback={
        <PageSkeleton
          variant="table-page"
          filterBar={false}
          pager={false}
          data-testid="topics-skeleton"
        />
      }
    >
      <TopicsContent appId={appId} facet={facet} />
    </Suspense>
  );
}
