import { NextRequest } from "next/server";
import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { CRON_SECRET } from "@/config-global.server";
import { safeCompare } from "@/utils/safe-compare";
import { WorkerReaperService } from "@/lib/system/workers/worker-reaper-service";

/**
 * Reaps overdue cloud worker runs. See
 * WorkerReaperService. Scheduled like the fly-machine-cleanup cron.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !safeCompare(authHeader, `Bearer ${CRON_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const reaper = new WorkerReaperService(createSupabaseAdminClient());
    const runs = await reaper.reapOverdueRuns();
    const environments = await reaper.reapIdleEnvironments();
    const result = { ...runs, environments };
    const anyProgress =
      runs.reaped.length > 0 || environments.suspended.length > 0 || environments.destroyed.length > 0;
    const anyFailure = runs.failed.length > 0 || environments.failed.length > 0;
    const failedOnly = !anyProgress && anyFailure;
    return Response.json(result, { status: failedOnly ? 500 : 200 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
