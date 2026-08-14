import "server-only";

/**
 * The artifact exhibit read behind the PR comment's evidence links: one
 * artifact row (RLS-scoped — `trace.read` on the app, same tenancy posture
 * as every read in this slice) plus a signed, expiring blob token so the
 * client can fetch the bytes through the agent-blob route. The comment on
 * GitHub carries only the page URL; the capability to the bytes is minted
 * here, per viewer, at view time.
 */
import { OAUTH_STATE_SECRET } from "@/config-global.server";

import { signAgentBlobToken } from "./blob-url";
import type { AgentSessionsContext } from "./service";

export interface ArtifactExhibit {
  id: string;
  filename: string;
  mediaType: string;
  kind: string;
  caption: string;
  criterionId: string;
  provenance: "session" | "ci" | "local";
  prNumber: number | null;
  repository: string;
  traceId: string;
  emittedAt: string;
  sha256: string;
  /** Capability token for the agent-blob route, bound to this viewer. */
  blobToken: string;
}

export async function getArtifactExhibit(
  ctx: AgentSessionsContext,
  artifactId: string,
): Promise<ArtifactExhibit | null> {
  // App-scoped like the page URL: an artifact belonging to another app 404s
  // here even when RLS would let this user read it — the page's app segment
  // must match the artifact's app, or its blob link (also app-scoped) could
  // never serve.
  const { data, error } = await ctx.db
    .from("artifact")
    .select(
      "id, app_id, filename, media_type, kind, caption, criterion_id, provenance, pr_number, repository, trace_id, emitted_at, sha256, verification, blob_deleted",
    )
    .eq("id", artifactId)
    .eq("app_id", ctx.appId)
    .maybeSingle();
  if (error) throw new Error(`artifact read failed: ${error.message}`);
  if (!data) return null;
  // An aged-out artifact's page dies with its blob — unmatched rows exist
  // only so the deletion job can find them, never to render.
  if (data.verification === "unmatched" || data.blob_deleted) return null;

  const blobToken = await signAgentBlobToken({
    secret: OAUTH_STATE_SECRET,
    claims: {
      tenantId: ctx.tenantId,
      appId: ctx.appId,
      userId: ctx.userId,
      sha256: data.sha256,
    },
  });

  return {
    id: data.id,
    filename: data.filename,
    mediaType: data.media_type,
    kind: data.kind,
    caption: data.caption,
    criterionId: data.criterion_id,
    provenance: data.provenance as ArtifactExhibit["provenance"],
    prNumber: data.pr_number === null ? null : Number(data.pr_number),
    repository: data.repository,
    traceId: data.trace_id,
    emittedAt: data.emitted_at,
    sha256: data.sha256,
    blobToken,
  };
}
