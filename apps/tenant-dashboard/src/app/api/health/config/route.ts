import { NextResponse } from "next/server";

import { CRON_SECRET } from "@/config-global.server";
import { checkConfigPosture, postureEnvFromProcess } from "@/lib/system/env-readiness";
import { safeCompare } from "@/utils/safe-compare";

/**
 * Config posture for this deployment: which capabilities are switched off or
 * narrowed by configuration.
 *
 * Missing config is not reported here — env.ts validates on deployments, so a
 * deployment short of required config fails its build and never serves. What
 * remains is the harder question: what is this deployment deliberately not
 * doing, that a reader of the code would assume it does.
 *
 * Authenticated with CRON_SECRET (same bearer convention as the cron routes)
 * because the answer names capabilities this deployment cannot perform. The
 * unauthenticated `/api/health` carries the same signal as a count.
 *
 * Answers "is this environment ready?" in one request — the question that
 * otherwise takes an afternoon of reading a hosting provider's API.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !safeCompare(authHeader, `Bearer ${CRON_SECRET}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const posture = checkConfigPosture(postureEnvFromProcess());

  return NextResponse.json({
    status: posture.degraded.length === 0 ? "full" : "degraded",
    ...posture,
  });
}
