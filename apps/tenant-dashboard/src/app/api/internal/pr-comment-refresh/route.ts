/**
 * PR Comment Refresh Route (internal, service-to-service).
 *
 * Called by the Cloudflare Worker queue consumer after coalescing a batch
 * of synced sessions into distinct `(tenant, repository, prNumber)`
 * triples, and by the hourly cron gap-repair sweep.
 * At-least-once delivery is expected — duplicates are harmless because
 * `refreshPrSessionComment` short-circuits on an unchanged rendered body
 * hash, so this route adds no caching of its own.
 *
 * Auth mirrors `/api/internal/worker-events`: a bearer token compared with a
 * timing-safe `safeCompare`, `Authorization: Bearer <secret>` header, and a
 * bare `{ error: "Unauthorized" }` 401 on failure. The one difference is by
 * necessity, not choice — `worker-events` verifies a *per-run* secret held
 * in Vault, which can only be resolved once the run id is known, so it reads
 * the body before checking auth. This route's secret is a single static
 * value (`PR_COMMENT_REFRESH_SECRET`), so there is no reason to do that: the
 * bearer token is checked before the request body is even parsed, and an
 * unauthenticated caller never causes a DB read or a parsing side effect.
 *
 * Tenancy: `tenantId` arriving in the request body is normally forbidden
 * (tenant must come from a verified session/webhook source) — this route is
 * the sanctioned exception, exactly like `worker-events`' `worker_run_id`.
 * It is a machine-to-machine endpoint gated by a shared secret, not a
 * session-authenticated one, and the caller (the queue consumer) only ever
 * knows tenant ids it already read off a verified sync payload.
 *
 * BLAST RADIUS of a leaked `PR_COMMENT_REFRESH_SECRET`, stated explicitly
 * because it is the argument for why the paragraph above is acceptable and
 * it is otherwise nowhere written down: a caller holding the secret may name
 * ANY `(tenantId, repository, prNumber)`. What it CANNOT do is choose the
 * content or the destination. `refreshPrSessionComment` → `readLinkedSessions`
 * re-checks `git_connection` for that exact `(tenantId, repository)` pair and
 * no-ops unless an app in THAT tenant has that repo connected with
 * `pr_comments_enabled`; the installation used to post is resolved from the
 * same row, and the body is rendered from that tenant's own sessions. So the
 * damage is bounded to posting a tenant's real session summary onto that
 * tenant's real, already-connected repository — a comment appearing earlier
 * than it should, never cross-tenant data and never a write into a repo the
 * tenant hasn't connected. It is NOT an injection surface: no field of the
 * request body reaches the rendered comment.
 *
 * POST /api/internal/pr-comment-refresh
 * Authorization: Bearer {PR_COMMENT_REFRESH_SECRET}
 * Body: { items: Array<{ tenantId, repository, prNumber }> }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { safeCompare } from "@/utils/safe-compare";
import { refreshPrSessionComment, type RefreshPrSessionCommentParams } from "@/lib/system/pr-session-comment";

const refreshItemSchema = z.object({
  tenantId: z.string().min(1),
  repository: z.string().min(1),
  prNumber: z.number().int().positive(),
});

// Bounded batch — the queue consumer coalesces one message per distinct
// (tenant, repository, prNumber) per delivery window, so a batch this large
// would only ever occur under an upstream bug; capping it keeps one request
// from fanning out into an unbounded number of GitHub calls.
const refreshBatchSchema = z.object({
  items: z.array(refreshItemSchema).min(1).max(200),
});

/** Timing-safe bearer-token check against the single shared secret. Fails
 * closed when the secret env var itself is unset, matching the DORA
 * ingestion route's posture for a missing/misconfigured secret. */
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.PR_COMMENT_REFRESH_SECRET;
  if (!expected) return false;
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  return safeCompare(authHeader.slice("Bearer ".length), expected);
}

export async function POST(request: NextRequest) {
  // Auth BEFORE any work — no body parsing, no DB reads. Unlike
  // worker-events' per-run secret, ours needs no lookup to verify.
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = refreshBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid refresh batch" }, { status: 400 });
  }

  // One bad/failing item must not fail the whole batch — refreshPrSessionComment
  // already resolves its own failures to a `{status: "failed"}` result rather
  // than throwing, but an unexpected exception in any one item is still caught
  // here so a sibling item's result is never lost.
  const results = await Promise.all(
    parsed.data.items.map(async (item: RefreshPrSessionCommentParams) => {
      try {
        const result = await refreshPrSessionComment(item);
        return { ...item, ...result };
      } catch (error) {
        return {
          ...item,
          status: "failed" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return NextResponse.json({ results });
}
