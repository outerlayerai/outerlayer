"use client";

/**
 * One artifact, rendered by kind: screenshots inline, videos playable,
 * everything else a download link — the dashboard end of the PR comment's
 * evidence links. Bytes come through the signed agent-blob route; the token
 * expires, so a stale tab renders the expired state instead of a broken
 * viewer, matching the transcript-image behavior.
 */
import { useState } from "react";
import { useParams } from "next/navigation";
import { Box, Card, Chip, Link, Stack, Typography } from "@mui/material";

import { PageHeader } from "@/components/page-header";
import { appPaths } from "@/routes/paths";
import type { ArtifactExhibit } from "../artifact-service";

function ExpiredNotice() {
  return (
    <Box
      sx={{
        borderRadius: 2, border: "1px dashed #E4E0D6", bgcolor: "#fff", p: 3,
        display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
      }}
    >
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
        Link expired — reload to view
      </Typography>
    </Box>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "baseline" }}>
      <Typography sx={{ fontSize: 12, color: "text.secondary", width: 88, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography component="div" sx={{ fontSize: 13, wordBreak: "break-word" }}>
        {children}
      </Typography>
    </Stack>
  );
}

export function ArtifactExhibitView({
  appId,
  appName,
  envName,
  artifact,
}: {
  appId: string;
  appName: string;
  envName: string;
  artifact: ArtifactExhibit;
}) {
  const { orgName } = useParams<{ orgName: string }>();
  const [failed, setFailed] = useState(false);
  // Same scheme the transcript image path uses: appId is the authorized
  // scope, the token the per-viewer expiring capability.
  const blobUrl = `/api/orgs/${orgName}/apps/${appId}/agents/blob/${artifact.sha256}?appId=${appId}&token=${encodeURIComponent(artifact.blobToken)}`;

  let media: React.ReactNode;
  if (failed) {
    media = <ExpiredNotice />;
  } else if (artifact.kind === "screenshot") {
    media = (
      <Box
        component="img"
        src={blobUrl}
        alt={artifact.filename}
        onError={() => setFailed(true)}
        sx={{ maxWidth: "100%", maxHeight: 640, borderRadius: 2, border: "1px solid #E4E0D6", objectFit: "contain", bgcolor: "#fff" }}
      />
    );
  } else if (artifact.kind === "video") {
    media = (
      <Box
        component="video"
        src={blobUrl}
        controls
        onError={() => setFailed(true)}
        sx={{ maxWidth: "100%", maxHeight: 640, borderRadius: 2, border: "1px solid #E4E0D6", bgcolor: "#000" }}
      />
    );
  } else {
    media = (
      <Link href={blobUrl} target="_blank" rel="noopener" sx={{ fontSize: 14 }}>
        Download {artifact.filename}
      </Link>
    );
  }

  return (
    <Stack spacing={2} data-testid="artifact-exhibit">
      <PageHeader
        title={artifact.filename}
        caption={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Chip size="small" label={artifact.kind} data-testid="artifact-kind-chip" />
            <Chip
              size="small"
              variant="outlined"
              label={artifact.provenance}
              data-testid="artifact-provenance-chip"
            />
          </Stack>
        }
      />
      <Card sx={{ p: 2 }}>{media}</Card>
      <Card sx={{ p: 2 }}>
        <Stack spacing={1}>
          {artifact.caption !== "" && <MetaRow label="Caption">{artifact.caption}</MetaRow>}
          {artifact.criterionId !== "" && (
            <MetaRow label="Proves">
              <Box component="code" sx={{ fontSize: 12.5 }}>{artifact.criterionId}</Box>
            </MetaRow>
          )}
          {artifact.prNumber !== null && (
            <MetaRow label="Pull request">
              {artifact.repository !== "" ? `${artifact.repository} ` : ""}#{artifact.prNumber}
            </MetaRow>
          )}
          {artifact.traceId !== "" && (
            <MetaRow label="Session">
              <Link href={appPaths.agents.session(orgName, appName, envName, artifact.traceId)}>
                {artifact.traceId.slice(0, 8)}
              </Link>
            </MetaRow>
          )}
          <MetaRow label="Emitted">{new Date(artifact.emittedAt).toLocaleString()}</MetaRow>
        </Stack>
      </Card>
    </Stack>
  );
}
