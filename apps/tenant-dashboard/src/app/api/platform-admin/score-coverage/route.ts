/**
 * Outcome-score coverage — GET API Route
 *
 * Compares terminal-fated PRs with confirmed session links against the
 * `worker.*` outcome scores materialized in ClickHouse (outcome-scores/emit.ts),
 * and returns the gap. This is the reconciliation query online evals needs as
 * coverage evidence — run it against staging after a soak week, and use
 * `missingSamples` (or any covered link) to hand-pick PRs for the ground-truth
 * audit.
 *
 * Auth: platform admin only (withPlatformAdminAuth). Query params: appId
 * (optional UUID filter) and prNumber (optional — look up one specific PR's
 * links/scores directly, instead of the arbitrary-order `coveredSamples`
 * slice, for a targeted ground-truth-audit check).
 */

import { NextResponse } from "next/server";
import { getScoreCoverage } from "@/lib/system/score-coverage/service";

import { withPlatformAdminAuth } from "../auth";

export const GET = withPlatformAdminAuth(async (request, _context) => {
  try {
    const url = new URL(request.url);
    const appId = url.searchParams.get("appId") ?? undefined;
    const prNumberRaw = url.searchParams.get("prNumber");
    const prNumber = prNumberRaw !== null ? Number(prNumberRaw) : undefined;
    if (prNumberRaw !== null && (!Number.isFinite(prNumber) || prNumber! <= 0)) {
      return NextResponse.json({ error: "prNumber must be a positive number" }, { status: 400 });
    }

    const result = await getScoreCoverage({ appId, prNumber });
    if (result.skipped) {
      return NextResponse.json({ skipped: true, reason: "clickhouse not configured" });
    }

    const { skipped: _skipped, ...coverage } = result;
    return NextResponse.json(coverage);
  } catch (error) {
    console.error("[score-coverage] Failed to compute score coverage:", error);
    return NextResponse.json({ error: "Failed to compute score coverage" }, { status: 500 });
  }
});
