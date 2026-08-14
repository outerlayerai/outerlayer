import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton, Stack } from "@mui/material";
import { resolveAgentSessionsContext } from "@/features/agent-sessions/request-context";
import { getArtifactExhibit } from "@/features/agent-sessions/artifact-service";
import { ArtifactExhibitView } from "@/features/agent-sessions/components/artifact-exhibit";

function ArtifactSkeleton() {
  return (
    <Stack spacing={2} data-testid="artifact-skeleton">
      <Skeleton variant="text" width={280} height={40} />
      <Card sx={{ p: 2 }}>
        <Skeleton variant="rounded" height={320} />
      </Card>
    </Stack>
  );
}

async function ArtifactExhibitPage({
  appName,
  envName,
  artifactId,
}: {
  appName: string;
  envName: string;
  artifactId: string;
}) {
  const ctx = await resolveAgentSessionsContext(appName);
  if (!ctx) notFound();

  // Not-found and not-this-app's-artifact are indistinguishable on purpose —
  // same no-existence-oracle posture as session detail.
  const artifact = await getArtifactExhibit(ctx, artifactId);
  if (!artifact) notFound();

  return (
    <ArtifactExhibitView
      appId={ctx.appId}
      appName={appName}
      envName={envName}
      artifact={artifact}
    />
  );
}

export default async function AgentArtifactPage({
  params,
}: {
  params: Promise<{ appName: string; envName: string; artifactId: string }>;
}) {
  const { appName, envName, artifactId } = await params;
  return (
    <Suspense fallback={<ArtifactSkeleton />}>
      <ArtifactExhibitPage appName={appName} envName={envName} artifactId={artifactId} />
    </Suspense>
  );
}
