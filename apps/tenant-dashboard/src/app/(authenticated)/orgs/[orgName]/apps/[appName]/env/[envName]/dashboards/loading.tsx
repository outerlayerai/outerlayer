import { PageSkeleton } from "@/components/page-skeleton";

/**
 * The list is read entirely on the server and the segment is force-dynamic, so
 * without this boundary the content frame stays blank for the whole read.
 *
 * `card-grid` mirrors the destination exactly on the axis that matters: the
 * dashboard cards sit in the same 3-up grid, under a header carrying a single
 * action. It over-reserves card height by a few dozen pixels, which is a far
 * smaller shift than the blank frame it replaces.
 */
export default function DashboardsLoading() {
  return <PageSkeleton variant="card-grid" data-testid="dashboards-loading" />;
}
