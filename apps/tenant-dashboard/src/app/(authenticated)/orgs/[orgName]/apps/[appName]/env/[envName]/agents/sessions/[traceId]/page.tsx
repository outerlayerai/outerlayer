import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton, Stack } from "@mui/material";
import { resolveAgentSessionsContext } from "@/features/agent-sessions/request-context";
import { agentSessionsService } from "@/features/agent-sessions/service";
import { AgentSessionDetail } from "@/features/agent-sessions/components/agent-session-detail";

/** Mirrors the destination layout — title, summary band, timeline entries —
 *  so the wait shows the page's shape instead of a page-sized spinner. */
function SessionDetailSkeleton() {
  return (
    <Stack spacing={2} data-testid="session-detail-skeleton">
      <Skeleton variant="text" width={280} height={40} />
      <Card sx={{ p: 2 }}>
        <Stack direction="row" spacing={3}>
          {Array.from({ length: 4 }, (_v, i) => (
            <Skeleton key={i} variant="rounded" width={120} height={48} />
          ))}
        </Stack>
      </Card>
      <Card sx={{ p: 2 }}>
        <Stack spacing={1.25}>
          {Array.from({ length: 6 }, (_v, i) => (
            <Skeleton key={i} variant="rounded" height={56} />
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}

async function SessionDetail({ appName, traceId }: { appName: string; traceId: string }) {
  const ctx = await resolveAgentSessionsContext(appName);
  if (!ctx) notFound();

  // Cross-actor detail 404s with no existence oracle — the service returns
  // null for both "no such trace" and "not this caller's session", and this
  // page must not distinguish the two.
  const data = await agentSessionsService.getSessionDetail(ctx, traceId);
  if (!data) notFound();

  return <AgentSessionDetail appId={ctx.appId} data={data} />;
}

export default async function AgentSessionDetailPage({
  params,
}: {
  params: Promise<{ appName: string; traceId: string }>;
}) {
  const { appName, traceId } = await params;
  return (
    <Suspense fallback={<SessionDetailSkeleton />}>
      <SessionDetail appName={appName} traceId={traceId} />
    </Suspense>
  );
}
