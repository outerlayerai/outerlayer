import { NextResponse } from "next/server";

import { CRON_SECRET } from "@/config-global.server";
import { checkEnvReadiness, readinessEnvFromProcess } from "@/lib/system/env-readiness";
import { safeCompare } from "@/utils/safe-compare";

/**
 * Config readiness for this deployment: which required variables are unset, and
 * which capabilities are switched off or narrowed by configuration.
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

  const readiness = checkEnvReadiness(readinessEnvFromProcess());

  return NextResponse.json(
    {
      status: readiness.missingRequired.length === 0 ? "ready" : "incomplete",
      ...readiness,
    },
    { status: readiness.missingRequired.length === 0 ? 200 : 503 }
  );
}
