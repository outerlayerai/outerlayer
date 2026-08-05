import "server-only";

/**
 * Persist a completed cloud-worker run as an Agent Session (AC-2 + AC-9).
 *
 * Two fidelity tiers, one deterministic identity (`worker-run:<runId>` →
 * TraceId), so whichever lands later replaces the other's rows:
 *
 *  1. TRANSCRIPT (full fidelity, preferred): the runner uploads the agent's
 *     raw stream-json transcript; the SAME @outerlayer/capture adapters that
 *     parse seat sessions rebuild it — real per-turn usage, thinking, images,
 *     per-turn cost. `persistWorkerRunTranscript` handles it.
 *  2. EVENT BRIDGE (fallback): the terminal callback rebuilds a session from
 *     the normalized worker_run_event stream. Skipped when a session for the
 *     run already exists (the transcript beat it); a late transcript still
 *     overwrites the bridge rows under the replacing tables.
 *
 * Both paths run the SAME gateway-core pipeline as `/v1/agents/sync` (tenant
 * tier clamp → secret scrub → span mapping), so cloud sessions obey capture
 * policy identically to CLI-synced ones.
 *
 * Attribution: the dispatching developer's membership id (the self-scope
 * key), stamped `workerKind: cloud`; no resolvable membership →
 * `key:cloud-worker`, never a guessed human (fail closed).
 *
 * A session is telemetry: persistence failures are logged, never surfaced to
 * the runner or allowed to fail the callback/upload.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@repo/db-types";
import {
  normalizeRepoRemote,
  workerRunSessionId,
  workerRunToAgentSession,
  type WorkerCallbackPayload,
} from "@repo/worker-core";
import {
  agentSessionToClickHouseRows,
  agentSessionSummaryRow,
  resolveTenantCaptureTier,
  traceIdForSession,
} from "@repo/gateway-core/services/agent-session-converter";
import { parseTranscript, parseCodexRollout, type CapturedBlob } from "@outerlayer/capture";
import { safeParseAgentSession, type AgentSession } from "@outerlayer/session-schema";
import { createClickHouseClient } from "@/lib/analytics/client";
import { serverLogger } from "@/lib/observability/server-logger";

/** Unattributed cloud runs (no requester membership): a key-style ActorId can
 * never collide with a membership UUID, so self-scoped lists never show it. */
export const CLOUD_WORKER_ACTOR = "key:cloud-worker";

/**
 * git_connection.repository → the sessions GitRepo join key. Hosted
 * connections store bare `owner/repo`; the CLI's key is host-qualified
 * (`github.com/owner/repo`), and the sessions list scopes by it — a mismatch
 * would strand cloud sessions outside the app's repo view. Anything already
 * URL/scp-shaped (self-host remotes, local dev paths) goes through the shared
 * normalizer instead.
 */
export function repoJoinKey(
  repository: string,
  _provider?: string | null,
): string | undefined {
  if (/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return `github.com/${repository.replace(/\.git$/, "")}`;
  }
  return normalizeRepoRemote(repository);
}

interface RunContext {
  run: {
    id: string;
    tenant_id: string;
    app_id: string;
    agent: string;
    task_prompt: string;
    base_branch: string;
    started_at: string | null;
    created_by: string | null;
  };
  gitRepo?: string;
  gitBranch?: string;
  actorId: string;
}

async function loadRunContext(
  supabase: SupabaseClient<Database>,
  workerRunId: string,
): Promise<RunContext | null> {
  const { data: run } = await supabase
    .from("worker_run")
    .select("id, tenant_id, app_id, agent, task_prompt, base_branch, started_at, created_by")
    .eq("id", workerRunId)
    .maybeSingle();
  if (!run) return null;

  const [{ data: connection }, membershipId] = await Promise.all([
    supabase.from("git_connection").select("repository, provider").eq("app_id", run.app_id).maybeSingle(),
    run.created_by
      ? supabase
          .from("membership")
          .select("id")
          .eq("user_id", run.created_by)
          .eq("tenant_id", run.tenant_id)
          .maybeSingle()
          .then((r) => r.data?.id ?? null)
      : Promise.resolve(null),
  ]);

  return {
    run,
    gitRepo: connection?.repository ? repoJoinKey(connection.repository, connection.provider) : undefined,
    gitBranch: run.base_branch || undefined,
    actorId: membershipId ?? CLOUD_WORKER_ACTOR,
  };
}

/** Tier-clamp + scrub + convert + insert (spans, rollup, image blobs). */
async function writeSession(
  supabase: SupabaseClient<Database>,
  ctx: RunContext,
  session: AgentSession,
  blobs: CapturedBlob[],
): Promise<boolean> {
  const tenantTier = await resolveTenantCaptureTier(supabase, ctx.run.tenant_id);
  const meta = {
    tenantId: ctx.run.tenant_id,
    appId: ctx.run.app_id,
    appName: "",
    branchId: "",
    stripeCustomerId: "",
    stripeSubscriptionId: "",
  };
  const opts = { meta, actorId: ctx.actorId, tenantTier };
  const spanRows = agentSessionToClickHouseRows(session, opts);
  const summaryRow = agentSessionSummaryRow(session, opts);

  const ch = createClickHouseClient();
  if (!ch) {
    await serverLogger.info("cloud-worker session not persisted: ClickHouse unconfigured", {
      workerRunId: ctx.run.id,
    });
    return false;
  }
  await ch.insert({
    table: "otel_traces",
    values: spanRows as unknown as Record<string, unknown>[],
    format: "JSONEachRow",
  });
  await ch.insert({
    table: "agent_session_summary",
    values: [summaryRow as unknown as Record<string, unknown>],
    format: "JSONEachRow",
  });
  // Image blobs (full tier only — lower tiers strip turn images, so ship
  // nothing the session doesn't reference). ClickHouse is the self-host
  // store the dashboard's blob route reads; object storage stays a gateway
  // concern.
  const effectiveBlobs = tenantTier === "full" ? blobs : [];
  if (effectiveBlobs.length > 0) {
    await ch.insert({
      table: "agent_blobs",
      values: effectiveBlobs.map((b) => ({
        TenantId: ctx.run.tenant_id,
        AppId: ctx.run.app_id,
        Sha256: b.sha256,
        MediaType: b.mediaType,
        Bytes: b.bytes,
        Data: b.data,
      })),
      format: "JSONEachRow",
    });
  }
  return true;
}

/** True when a session for this run already landed (either fidelity tier). */
async function hasPersistedSession(tenantId: string, appId: string, workerRunId: string): Promise<boolean> {
  const ch = createClickHouseClient();
  if (!ch) return false;
  const traceId = traceIdForSession(workerRunSessionId(workerRunId));
  const rows = await ch
    .query({
      query: `SELECT count() AS n FROM agent_session_summary
              WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND TraceId = {traceId:String}`,
      query_params: { tenantId, appId, traceId },
      format: "JSONEachRow",
    })
    .then((r) => r.json<{ n: string }>());
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Launcher-keyed raw-transcript parse — the same adapter set the CLI and
 * eval worker use. Unknown launchers return null (event bridge covers them). */
function parseByLauncher(agent: string, transcript: string, fallbackId: string) {
  if (agent === "claude-code") {
    return parseTranscript(transcript, { fallbackId, agentType: "claude-code", captureTier: "full" });
  }
  if (agent === "codex") {
    return parseCodexRollout(transcript, { fallbackId });
  }
  return null;
}

const epochIsh = (iso: string | undefined): boolean => {
  const t = iso ? Date.parse(iso) : NaN;
  return !Number.isFinite(t) || t < Date.parse("2001-01-01T00:00:00.000Z");
};

/**
 * Full-fidelity persist from the runner's raw transcript upload (AC-9).
 * Returns true when a session was written.
 */
export async function persistWorkerRunTranscript(
  supabase: SupabaseClient<Database>,
  workerRunId: string,
  transcript: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const ctx = await loadRunContext(supabase, workerRunId);
    if (!ctx) return false;

    const sessionId = workerRunSessionId(workerRunId);
    const parsed = parseByLauncher(ctx.run.agent, transcript, sessionId);
    if (!parsed?.session) return false;

    // Force the run's canonical identity over anything the transcript claims
    // (the eval worker's stampTrialIdentity pattern): deterministic id, cloud
    // origin, the app's repo join key, and sane timestamps — stream-json tees
    // often carry no absolute times, which would strand the session in 1970.
    const base = parsed.session;
    const endedAt = epochIsh(base.endedAt as string | undefined) ? now.toISOString() : (base.endedAt as string);
    const startedAt = epochIsh(base.startedAt) ? (ctx.run.started_at ?? endedAt) : base.startedAt;
    const stamped: AgentSession = {
      ...base,
      id: sessionId,
      workerKind: "cloud",
      // A worker run's origin is the run itself, not whatever prompt-source the
      // launched agent's transcript happened to carry (headless `claude -p`
      // writes sdk markers). Stamping 'worker' keeps these a distinct
      // population, queryable alongside workerKind.
      agent: { ...base.agent, type: ctx.run.agent, entrypoint: "cloud-worker", origin: "worker" },
      env: {
        ...base.env,
        ...(ctx.gitRepo ? { gitRepo: ctx.gitRepo } : {}),
        ...(ctx.gitBranch ? { gitBranch: ctx.gitBranch } : {}),
      },
      startedAt,
      endedAt,
      title: (typeof base.title === "string" && base.title) || ctx.run.task_prompt.split("\n")[0]?.slice(0, 120) || "Cloud worker run",
      vendor: {
        ...(base.vendor as Record<string, unknown> | undefined),
        workerRun: { runId: workerRunId, source: "transcript" },
      },
    };
    const valid = safeParseAgentSession(stamped);
    if (!valid.success) {
      await serverLogger.info("cloud-worker transcript session failed schema validation", {
        workerRunId,
        issue: valid.error.issues[0]?.message ?? "invalid",
      });
      return false;
    }

    return await writeSession(supabase, ctx, valid.data, parsed.blobs ?? []);
  } catch (err) {
    serverLogger.error(
      new Error(
        `persisting worker transcript as agent session failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { workerRunId },
    );
    return false;
  }
}

/**
 * Fallback persist from the normalized event stream, invoked at the terminal
 * callback. No-ops when the transcript path already landed a session.
 */
export async function persistWorkerRunAgentSession(
  supabase: SupabaseClient<Database>,
  payload: WorkerCallbackPayload,
  completedAt: Date = new Date(),
): Promise<void> {
  try {
    const ctx = await loadRunContext(supabase, payload.worker_run_id);
    if (!ctx) return;

    // The transcript upload precedes the callback in the runner; if its
    // full-fidelity session is already in, the low-fidelity bridge must not
    // overwrite it. (A LATE transcript still wins: same TraceId, replacing
    // tables.)
    if (await hasPersistedSession(ctx.run.tenant_id, ctx.run.app_id, ctx.run.id)) return;

    const { data: events } = await supabase
      .from("worker_run_event")
      .select("seq, event_type, payload")
      .eq("worker_run_id", ctx.run.id)
      .order("seq", { ascending: true });

    const session = workerRunToAgentSession({
      workerRunId: ctx.run.id,
      agentType: ctx.run.agent,
      taskPrompt: ctx.run.task_prompt,
      events: (events ?? []).map((e) => ({
        seq: e.seq,
        event_type: e.event_type,
        payload: (e.payload ?? {}) as Record<string, unknown>,
      })),
      callback: payload,
      startedAt: ctx.run.started_at,
      completedAt: completedAt.toISOString(),
      gitRepo: ctx.gitRepo,
      gitBranch: ctx.gitBranch,
    });

    await writeSession(supabase, ctx, session, []);
  } catch (err) {
    serverLogger.error(
      new Error(
        `persisting worker run as agent session failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { workerRunId: payload.worker_run_id },
    );
  }
}
