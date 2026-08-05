// Ephemeral Fly Machine worker (least-privilege). ONE run per Machine: the dispatcher starts a Machine
// with the run's coordinates in env + auto_destroy=true; this process fetches
// its job from the GATEWAY, runs it (runReport → E2B), persists trials +
// trajectories, reports the terminal status back, and exits → the Machine
// self-destructs (idle cost $0). The dashboard client polls eval_run for the
// result, so no callback to the dashboard is needed.
//
// SECURITY MODEL: the worker holds NO database credential. Its only secret is
// EVAL_GATEWAY_KEY — the per-run gateway key minted at dispatch (env-bound,
// named for this run, 24h expiry), which the gateway REVOKES when the worker
// reports a terminal status. Every control-plane operation (job read, status,
// escalations) goes through gateway endpoints that are server-side bound to
// exactly this run. The Machine config is readable by Fly-token holders, so
// the key riding in it is a conscious trade: what a reader gains is one run's
// scoped, short-lived, self-destructing credential — never a service role.
// E2B_API_KEY remains a Fly APP secret (`fly secrets set`), inherited at boot.
import {
  EvalGatewayClient,
  buildTrialSessions,
  evalTrialSessionId,
  persistingEscalationSink,
  persistTrialResults,
  persistTrialSessions,
} from "./dist/index.js";
import { runReport } from "./run-eval.mjs";

const RUN_ID = process.env.RUN_ID;
const APP_ID = process.env.EVAL_APP_ID;
const GATEWAY_URL = process.env.EVAL_GATEWAY_URL;
const GATEWAY_KEY = process.env.EVAL_GATEWAY_KEY;
if (!RUN_ID || !APP_ID || !GATEWAY_URL || !GATEWAY_KEY) {
  console.error("[eval-worker] missing RUN_ID / EVAL_APP_ID / EVAL_GATEWAY_URL / EVAL_GATEWAY_KEY");
  process.exit(1);
}

const gw = new EvalGatewayClient({ gatewayUrl: GATEWAY_URL, apiKey: GATEWAY_KEY, appId: APP_ID, runId: RUN_ID });

/** POST the run's trajectories (AgentSessions) then full TrialResults
 * (scores + artifact blobs). Best-effort by design: the persist fns never
 * throw, and a failure here must never fail a run that graded. Runs BEFORE
 * the terminal status report — completing the run revokes the key. */
async function persistTrials(job, trials, transcripts) {
  if (!Array.isArray(trials) || trials.length === 0) return;
  const opts = { gatewayUrl: GATEWAY_URL, apiKey: GATEWAY_KEY, appId: APP_ID, evalRunId: RUN_ID };
  const sessions = buildTrialSessions(trials, transcripts, {
    evalRunId: RUN_ID,
    repoLabel: job.repoLabel || undefined,
  });
  const sessionReport = await persistTrialSessions(sessions, opts);
  const report = await persistTrialResults(trials, opts);
  console.log(
    `[eval-worker] persisted sessions: ${sessionReport.accepted}/${sessionReport.total} accepted; ` +
      `trials: ${report.accepted}/${report.total} accepted, ${report.rejected} rejected, ${report.failedChunks} failed chunk(s)`,
  );
}

async function main() {
  const job = await gw.fetchJob();
  console.log(`[eval-worker] run=${RUN_ID} app=${job.appId} env=${job.environmentId ?? "default"} status=${job.status}`);

  // A restarted Machine after completion has nothing to do (the terminal
  // report also revoked the key, so normally we would not even get here).
  if (job.status === "succeeded" || job.status === "failed") {
    console.log(`[eval-worker] run already terminal (${job.status}); exiting`);
    process.exit(0);
  }

  // Claim (idempotent — a Fly restart re-claims the same run).
  await gw.claim();

  const req = job.request ?? {};
  const body = {
    repoLabel: job.repoLabel,
    taskCount: req.taskCount,
    trialsPerTask: req.trialsPerTask,
    configs: req.configs,
  };

  // Exhausted env-repair ladders become escalation tickets via the
  // gateway sink + an `_alert` log line. A queue-write failure only logs — it
  // never fails the run. (Tenant identity is stamped server-side from the key
  // binding; the worker deliberately does not know it.)
  const escalationSink = persistingEscalationSink(
    { tenantId: "", appId: job.appId, evalRunId: RUN_ID },
    gw.escalationWriter(),
  );

  // Raw launcher transcripts per trial — keyed by the canonical
  // trial session id; a retried attempt overwrites with its own transcript.
  const transcripts = new Map();
  const onTranscript = (transcript, meta) => {
    transcripts.set(evalTrialSessionId(RUN_ID, meta.taskId, meta.configId, meta.trialIndex), {
      transcript,
      launcher: meta.launcher,
    });
  };

  try {
    const result = await runReport(body, { escalationSink, onTranscript });
    // Persistence FIRST (it needs the key), then the terminal report — which
    // writes the card and revokes the key in the same call.
    await persistTrials(job, result.trials, transcripts).catch((err) => {
      console.log(JSON.stringify({ _alert: true, evt: "eval.persist.failed", runId: RUN_ID, detail: String(err?.message ?? err).slice(0, 500) }));
    });
    await gw.complete(result.card, result.spentUsd ?? 0);
    console.log(`[eval-worker] done: verdict=${result.card.verdict} cost=$${(result.spentUsd ?? 0).toFixed(4)}`);
    process.exit(0);
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 2000);
    console.error(`[eval-worker] failed: ${msg}`);
    await gw.fail(msg).catch((reportErr) => {
      // Gateway unreachable at the very end: the run reaper + the key's 24h
      // expiry are the backstops.
      console.error(`[eval-worker] could not report failure: ${String(reportErr?.message ?? reportErr).slice(0, 300)}`);
    });
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("[eval-worker] fatal:", err);
  await gw.fail(String(err?.message ?? err).slice(0, 2000)).catch(() => {});
  process.exit(1);
});
