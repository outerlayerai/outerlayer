import { PageSkeleton } from "@/components/page-skeleton";

/**
 * Every surface on this route is server-loaded — the app id, repo label,
 * environment, escalation queue, and run history all resolve in the React Server Component (RSC) before
 * anything renders — so without this boundary the content frame stays blank for
 * the whole read. The table variant mirrors the destination: the header block
 * over the run-history table.
 */
export default function BenchmarksLoading() {
  return <PageSkeleton variant="table-page" data-testid="benchmarks-loading" />;
}
