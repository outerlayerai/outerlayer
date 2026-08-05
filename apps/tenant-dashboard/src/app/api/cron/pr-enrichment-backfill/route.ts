import { NextRequest } from "next/server";
import { CRON_SECRET } from "@/config-global.server";
import { safeCompare } from "@/utils/safe-compare";
import { backfillPrEnrichment } from "@/lib/system/pr-tracking/enrichment-backfill";

/**
 * One-shot, manually invoked catch-up (NOT registered in vercel.json —
 * there is nothing to run on a schedule): enriches EXISTING connections'
 * decided PRs with diff size + first-pass CI verdicts from the provider
 * APIs. Future repo links get the same enrichment automatically in the
 * link flow; this exists for apps connected before enrichment shipped.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$HOST/api/cron/pr-enrichment-backfill?tenant=<tenantId>&days=90&limit=200"
 *
 * `tenant` narrows the sweep to one tenant's connections (omit for all);
 * `days` bounds the decided-at cutoff; `limit` caps PRs per connection
 * (each candidate costs up to two provider API calls).
 */
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !safeCompare(authHeader, `Bearer ${CRON_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const tenantId = params.get("tenant") ?? undefined;
  const days = Number.parseInt(params.get("days") ?? "", 10);
  const limit = Number.parseInt(params.get("limit") ?? "", 10);

  try {
    const result = await backfillPrEnrichment({
      tenantId,
      sinceDays: Number.isFinite(days) ? Math.min(Math.max(days, 1), 365) : undefined,
      perConnectionLimit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : undefined,
    });
    const anyProgress = result.diffFilled > 0 || result.ciFilled > 0 || result.examined > 0;
    const failedOnly = !anyProgress && result.errors.length > 0;
    return Response.json(result, { status: failedOnly ? 500 : 200 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
