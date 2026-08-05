import { Stack } from "@mui/material";
import { EvalsSection } from "@/features/evals";
import { getAppIdByName } from "@/utils/get-app-id";
import { getAppRepoLabel } from "@/utils/get-app-repo-label";
import { EscalationQueue } from "@/features/escalations";
import { loadEscalationsForApp } from "@/features/escalations/read";
import type { EnvEscalationRow } from "@/features/escalations";
import { loadEvalRunsForApp } from "@/features/evals/read";
import type { EvalRunSummary } from "@/features/evals/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRequestServiceContext } from "@/lib/adapters";
import { resolveEnvIdForStorage } from "@/lib/environments/env-scope";
import type { Database } from "@/types/db";

export const dynamic = "force-dynamic";

export default async function EvalsPage({
  params,
}: {
  params: Promise<{ appName: string; envName: string }>;
}) {
  const { appName, envName } = await params;
  const appId = await getAppIdByName(appName);

  // No single read takes down the whole benchmarks page. The escalation queue
  // and the run history each carry a failure FLAG to their own surface, so an
  // empty result always means "none" and never "the read failed": both render
  // as nothing/cold-start when genuinely empty. The repo label and environment
  // id have no such surface and degrade to a working default instead.
  //
  // The flag is fixed copy, never the caught error's message: these messages
  // wrap PostgREST/Postgres text verbatim (relation names, query fragments,
  // connection targets), and threading a thrown server error into props routes
  // around the framework's own production redaction. The detail belongs in the
  // server log, which is why every catch here still logs.
  let initialEscalations: EnvEscalationRow[] = [];
  let escalationsError: string | null = null;
  let initialRuns: EvalRunSummary[] = [];
  let runsError: string | null = null;
  let repoLabel = "your linked repo";
  let environmentId: string | undefined;
  if (appId) {
    try {
      initialEscalations = await loadEscalationsForApp(appId);
    } catch (err) {
      console.error("[benchmarks] escalation queue read failed:", err);
      escalationsError = "Couldn't load the environment build escalations.";
    }
    try {
      initialRuns = await loadEvalRunsForApp(appId);
    } catch (err) {
      console.error("[benchmarks] run history read failed:", err);
      runsError = "Couldn't load the run history.";
    }
    try {
      repoLabel = await getAppRepoLabel(appId);
    } catch (err) {
      console.error("[benchmarks] repo label read failed:", err);
    }
    try {
      // `resolveEnvIdForStorage` wants the real `SupabaseClient` type;
      // `ServiceContext.db` is deliberately narrowed to just `from()` to keep
      // the service layer decoupled from supabase-js (see service-context.ts).
      // The concrete, RLS-scoped client the adapter wires up satisfies it.
      const ctx = await loadRequestServiceContext();
      const scope = await resolveEnvIdForStorage(ctx.db as SupabaseClient<Database>, appId, { envName });
      environmentId = scope?.envId;
    } catch (err) {
      console.error("[benchmarks] environment resolution failed:", err);
    }
  }

  return (
    <Stack spacing={3}>
      <EscalationQueue
        appId={appId ?? undefined}
        initialEscalations={initialEscalations}
        readError={escalationsError}
      />
      <EvalsSection
        appId={appId ?? undefined}
        repoLabel={repoLabel}
        initialRuns={initialRuns}
        runsError={runsError}
        environmentId={environmentId}
      />
    </Stack>
  );
}
