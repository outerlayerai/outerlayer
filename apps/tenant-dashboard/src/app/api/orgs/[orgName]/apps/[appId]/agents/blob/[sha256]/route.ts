/**
 * Agent image blob serve. Content-addressed: the turn span carries only
 * the sha256; the bytes come from here. The sync endpoint (POST /v1/agents/sync)
 * dual-writes every blob: an `agent_blobs` ClickHouse row (served here) AND
 * object storage via the blob-storage seam (served by the gateway's
 * GET /v1/agents/blob/:sha256 for API consumers). The transcript `<img src>`
 * is built from this canonical org-scoped URL.
 *
 * A binary-asset route: an `<img>` needs bytes, which a React Server Component
 * (RSC) can't return, so agent-sessions keeps this one first-party route while
 * serving the rest of the domain from server components. It lives under
 * `/orgs/{orgName}/apps/{appId}`, the tenant-scoped path shape the whole domain
 * uses.
 *
 * Scoped to the caller's tenant+app so one tenant can't read another's blobs
 * by guessing a hash.
 *
 * Actor privacy: the table is content-addressed with no ActorId (identical
 * images from many sessions collapse to one row), so the row cannot say whose
 * copy it is. The binding to a person lives on the URL instead: session
 * detail — which IS actor-gated (features/agent-sessions/scope.ts) — mints a
 * signed token per image for the caller who asked for that transcript, and
 * this route re-checks it against the tenant, app, user, and hash it
 * authorized. A URL that escapes into a log, an export, or browser history is
 * therefore useless to a colleague and dead to everyone once it expires.
 */
import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError, ForbiddenError } from "@repo/observability-service";
import { withApi } from "@/lib/api/with-api";
import { createTenantReadClient } from "@/lib/analytics/client";
import { OAUTH_STATE_SECRET } from "@/config-global.server";
import { verifyAgentBlobToken } from "@/features/agent-sessions/blob-url";

const Query = z.object({
  appId: z.string(),
  // The capability. Minted by the session-detail read, single-image scoped.
  token: z.string().min(1),
});
// `appId` is also authorized off the query string (`withApi`); the path
// segment is the canonical URL's copy of the same value — pinned equal below
// so the URL can never name a different app than the one actually authorized.
const Params = z.object({
  orgName: z.string().min(1),
  appId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const GET = withApi(
  {
    method: "get",
    path: "/api/orgs/{orgName}/apps/{appId}/agents/blob/{sha256}",
    tags: ["Agents"],
    summary: "Agent image blob (content-addressed)",
    operationId: "get-agents-blob",
    request: { query: Query, params: Params },
    responses: {
      200: { description: "Image bytes." },
      403: { description: "Missing, altered, or expired image token." },
      404: { description: "Not found." },
    },
  },
  async ({ context, input }) => {
    if (input.params.appId !== input.query.appId) {
      throw new ValidationError("appId path segment and query must match");
    }

    // Verified before the store is touched, so a bad token learns nothing
    // about which hashes exist. Every claim is re-checked against the
    // request this route actually authorized — a token minted for another
    // person, app, tenant, or image is as good as no token at all.
    const verified = await verifyAgentBlobToken({
      secret: OAUTH_STATE_SECRET,
      token: input.query.token,
    });
    if (
      !verified.ok ||
      verified.claims.tenantId !== context.tenantId ||
      verified.claims.appId !== context.appId ||
      verified.claims.userId !== context.userId ||
      verified.claims.sha256 !== input.params.sha256
    ) {
      throw new ForbiddenError("Image link is invalid or has expired");
    }

    // Row-policy-scoped read: tenant + app pinned from the resolved auth
    // context — ClickHouse enforces the tenant boundary.
    const ch = createTenantReadClient({ tenantId: context.tenantId, appId: context.appId });
    if (!ch) throw new Error("ClickHouse not configured");
    const { tenantId, appId } = context;
    const { sha256 } = input.params;

    const rows = await ch
      .query({
        query: `SELECT MediaType AS mediaType, Data AS data FROM agent_blobs FINAL
                WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND Sha256 = {sha256:String}
                LIMIT 1`,
        query_params: { tenantId, appId, sha256 },
        format: "JSONEachRow",
      })
      .then((r) => r.json<{ mediaType: string; data: string }>());

    const blob = rows[0];
    if (!blob) return NextResponse.json({ error: "not found" }, { status: 404 });

    const bytes = Buffer.from(blob.data, "base64");
    // The bytes are immutable (content-addressed) and the URL is unique per
    // token, so caching is safe — but the entry must not outlive the link
    // that fetched it, or the browser would keep serving an image whose
    // capability has expired. Cache for whatever the token has left.
    const maxAge = Math.max(0, verified.claims.exp - Math.floor(Date.now() / 1000));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": blob.mediaType || "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Cache-Control": `private, max-age=${maxAge}, immutable`,
      },
    });
  },
);
