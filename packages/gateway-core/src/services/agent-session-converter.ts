import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SpanType, type NormalizedSpan } from "@repo/shared-utils";
import {
  downconvertSession,
  EVENT_TYPES,
  isHumanUserTurn,
  tierAtLeast,
  WORKER_KINDS,
  type AgentSession,
  type CaptureTier,
  type WorkerKind,
} from "@outerlayer/session-schema";
import {
  costForUsage,
  modelsTokenPricing,
  resolveModelPrice,
  type TokenPricingDictionary,
} from "@repo/llm-costs";
import { normalizedSpanToClickHouseRow } from "./span-converter";
import type { UserMeta, PricingData } from "../types";

/**
 * Ingest mapping: canonical AgentSession (coding-agent sessions captured by
 * the OuterLayer CLI) → NormalizedSpan tree → otel_traces rows.
 *
 * This is the only session→span mapping this gateway runs, and it enters
 * AFTER two hard gates:
 *
 *  1. TIER ENFORCEMENT (defense in depth): the effective tier is the LOWER of
 *     what the client sent and what the tenant allows — a lying client gets
 *     truncated server-side via the schema package's own `downconvertSession`
 *     (one definition of the field→tier table, both sides of the wire).
 *  2. SECRET SCRUB: every content-bearing field is scrubbed against a compact
 *     high-signal secret pattern set BEFORE write, at every tier.
 *
 * Mapping conventions (SpanName is LowCardinality — names stay a bounded
 * vocabulary; identity/high-cardinality detail rides Metadata):
 *   agent.session                 root span; no cost/tokens (SUM over turns
 *                                 must not double-count); events carried here
 *   agent.turn.user|assistant     one span per turn; assistant = GENERATION
 *                                 with per-turn model/tokens/cost
 *   agent.tool.<Name>             child of its assistant turn; error status +
 *                                 signature; tool I/O in Input/Output
 *
 * IDs are DETERMINISTIC (traceId from the session id; spanIds hashed from
 * stable paths) so a re-sync re-inserts identical rows — idempotent under the
 * table's replacing semantics, no dedup bookkeeping needed.
 */

// ---------------------------------------------------------------------------
// secret scrub
// ---------------------------------------------------------------------------

/** Compact, high-signal secret patterns (gitleaks-style). Order matters:
 * multiline/private-key first so later single-line passes see placeholders. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[SCRUBBED:private-key]"],
  [/AKIA[0-9A-Z]{16}/g, "[SCRUBBED:aws-key-id]"],
  [/\b(aws_?secret_?access_?key)\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}["']?/gi, "$1=[SCRUBBED:aws-secret]"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, "[SCRUBBED:github-token]"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[SCRUBBED:anthropic-key]"],
  [/sk_(?:live|test)_[A-Za-z0-9]{16,}/g, "[SCRUBBED:stripe-key]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[SCRUBBED:api-key]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[SCRUBBED:slack-token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[SCRUBBED:jwt]"],
  [/\b(api[_-]?key|auth[_-]?token|secret|password)\b(["']?\s*[:=]\s*)["'][^"'\n]{8,}["']/gi, "$1$2\"[SCRUBBED]\""],
];

// Home-directory anonymization mirrors the client scrubber: the account
// segment of a home-dir path names the developer in every row, so collapse it
// to `~` while preserving the remainder and its separator style. Defense in
// depth — a client that skipped scrubbing (or a non-CLI ingest path) still
// lands anonymized. The exact-$HOME substitution is client-only (no per-machine
// homedir at ingest); these shape patterns are what the server can know.
const HOME_SEG = "[A-Za-z0-9._-]+";
const HOME_LEAD = "(^|[\\s\"'`=(:[])";
const HOME_END = "(?=[\\\\/]|[\\s\"'`)\\],]|$)";
// Longest-first where one prefix contains another (`/var/home` before `/home`).
const HOME_PREFIXES = [
  "[A-Za-z]:[\\\\/]Users[\\\\/]" + HOME_SEG, // Windows C:\Users\u | C:/Users/u
  "[A-Za-z]:[\\\\/]Documents and Settings[\\\\/]" + HOME_SEG, // legacy Windows
  "\\\\\\\\wsl\\$[\\\\/]" + HOME_SEG + "[\\\\/]home[\\\\/]" + HOME_SEG, // \\wsl$\distro\home\u
  "\\\\\\\\" + HOME_SEG + "[\\\\/]Users[\\\\/]" + HOME_SEG, // UNC \\host\Users\u
  "/mnt/[A-Za-z]/Users/" + HOME_SEG, // WSL /mnt/c/Users/u
  "/var/home/" + HOME_SEG, // ostree
  "/Users/" + HOME_SEG, // macOS
  "/home/" + HOME_SEG, // Linux
  "/root", // Linux root — no user segment
];
const HOME_PATH = new RegExp(HOME_LEAD + "(?:" + HOME_PREFIXES.join("|") + ")" + HOME_END, "gi");

/** Scrub one string. Exported for direct testing. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(HOME_PATH, (_m, lead: string) => `${lead}~`);
  return out;
}

/**
 * Scrub every content-bearing field of a session IN a defensive copy.
 * Runs at every tier (metrics-tier sessions have no content, so it's free).
 */
export function scrubSession(session: AgentSession): AgentSession {
  const copy = structuredClone(session) as AgentSession;
  // The schema is deliberately loose — content fields can arrive as arrays
  // (structured tool_result blocks) or other shapes. Scrub strings in place;
  // stringify-and-scrub everything else so no secret rides through un-scrubbed.
  const scrubAny = (v: unknown): unknown => {
    if (v == null) return v;
    if (typeof v === "string") return scrubText(v);
    const scrubbed = scrubText(JSON.stringify(v));
    try {
      return JSON.parse(scrubbed);
    } catch {
      // a replacement broke the serialized shape — keep the scrubbed STRING
      // (secrets gone > structure kept; never drop the session for this)
      return scrubbed;
    }
  };
  if (copy.title != null) copy.title = scrubAny(copy.title) as typeof copy.title;
  // Structured path fields (cwd + tool-call file) flow into span metadata, so
  // they carry the same username-in-path leak as free content and must pass
  // the home scrub too. The client already relativizes/anonymizes these; this
  // is the ingest belt for a client that didn't.
  if (copy.env && typeof copy.env.cwd === "string") copy.env.cwd = scrubText(copy.env.cwd);
  for (const turn of copy.turns) {
    if (turn.text != null) turn.text = scrubAny(turn.text) as typeof turn.text;
    if (turn.thinking != null) turn.thinking = scrubAny(turn.thinking) as typeof turn.thinking;
    for (const call of turn.toolCalls) {
      if (typeof call.file === "string") call.file = scrubText(call.file);
      if (call.input != null) call.input = scrubAny(call.input) as typeof call.input;
      if (call.output != null) call.output = scrubAny(call.output) as typeof call.output;
      if (call.errorSignature != null) call.errorSignature = scrubAny(call.errorSignature) as typeof call.errorSignature;
    }
  }
  for (const event of copy.events) {
    if (event.data && typeof event.data === "object") {
      for (const [k, v] of Object.entries(event.data as Record<string, unknown>)) {
        // scrubAny (not scrubMaybe): event data can nest content — a hook's
        // command string rides inside `data.hooks[]`, not as a top-level
        // string — so a shallow scrub would miss it.
        (event.data as Record<string, unknown>)[k] = scrubAny(v);
      }
    }
    // errorText (hook stderr) rides its own field, not `data` — scrub it too,
    // full-tier or not: downconvertSession strips it below full, but a
    // full-tier session must still have its secrets scrubbed like any other
    // content field.
    if (Array.isArray(event.errorText)) {
      event.errorText = event.errorText.map((t) => (typeof t === "string" ? scrubText(t) : t));
    }
  }
  return copy;
}

// ---------------------------------------------------------------------------
// deterministic identity
// ---------------------------------------------------------------------------

/** Session id → 32-hex trace id. UUIDs map losslessly (dashes stripped);
 * anything else hashes. Deterministic → idempotent re-sync. */
export function traceIdForSession(sessionId: string): string {
  const stripped = sessionId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(stripped)) return stripped;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** Stable 16-hex span id from the trace id + a stable tree path. */
export function spanIdForPath(traceId: string, path: string): string {
  return createHash("sha256").update(`${traceId}:${path}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// tier gate
// ---------------------------------------------------------------------------

/** The effective tier is the LOWER of client-declared and tenant-configured —
 * the server never stores more than the tenant allows, whatever the client
 * claims (clients lie; the write path doesn't). */
export function effectiveTier(clientTier: CaptureTier, tenantTier: CaptureTier): CaptureTier {
  return tierAtLeast(clientTier, tenantTier) ? tenantTier : clientTier;
}

/**
 * Tenant capture ceiling from `tenant.agent_capture_tier`. Row/read failures
 * fall back to the spec default 'redacted' — never fail an ingest because a
 * config read blipped, and never fall OPEN to 'full'. Lives here (not in the
 * sync route) so every ingest surface — gateway sync AND the dashboard's
 * cloud-worker persist — enforces the identical ceiling.
 */
export async function resolveTenantCaptureTier(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<CaptureTier> {
  try {
    const { data } = await supabase
      .from("tenant")
      .select("agent_capture_tier")
      .eq("tenant_id", tenantId)
      .single();
    const tier = (data as { agent_capture_tier?: unknown } | null)?.agent_capture_tier;
    if (tier === "metrics" || tier === "redacted" || tier === "full") return tier;
  } catch (e) {
    // Read FAILURE stays conservative: a tenant that opted DOWN must not have
    // content uploaded because of a transient DB blip.
    console.warn("[agent-session] tenant tier read failed, defaulting to redacted:", e);
    return "redacted";
  }
  // No row / invalid value: full — content is the product.
  return "full";
}

// ---------------------------------------------------------------------------
// worker kind
// ---------------------------------------------------------------------------

/**
 * Run-origin attribution: a declared, valid kind wins; a missing or
 * junk one defaults from the key binding — actor-bound keys are developer
 * seats, shared keys are unattributed. Mislabeling only misfiles the tenant's
 * own analytics (not a privacy boundary, unlike ActorId), so client-declared
 * with a server default is enough.
 */
export function resolveWorkerKind(session: AgentSession, actorId: string): WorkerKind {
  const declared = session.workerKind;
  if (typeof declared === "string" && (WORKER_KINDS as readonly string[]).includes(declared)) {
    return declared as WorkerKind;
  }
  return actorId.startsWith("key:") ? "shared" : "seat";
}

// ---------------------------------------------------------------------------
// AgentSession → NormalizedSpan tree
// ---------------------------------------------------------------------------

/** Content fields are loosely typed — arrays/objects stringify at the span
 * boundary (Output/Input are string columns). */
const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** Hook span name per originating hook event — a bounded vocabulary, since
 * SpanName is LowCardinality. `PreToolUse`/`PostToolUse` reach this map only
 * for a wrapped hook (`hooks wrap`) — the transcript itself never times
 * those events, so an unwrapped session's hook spans are always Stop. */
const HOOK_SPAN_NAMES: Record<string, string> = {
  Stop: "agent.hook.stop",
  PreToolUse: "agent.hook.pre_tool_use",
  PostToolUse: "agent.hook.post_tool_use",
};

// Same bound the client parser caps `data.hooks[]` at — session events are
// client-supplied JSON, so the server must not trust the client actually
// applied its own cap. Without this, one event can expand into unbounded
// span rows.
const HOOK_ENTRIES_CAP = 50;

/** ClickHouse UInt32 ceiling — SlowestHookMs's column type, and the upper
 * sanity bound for any hook duration (≈49.7 days — far beyond any real
 * hook, but comfortably inside it lets legitimate long-running hooks
 * through while an absurd client-supplied value doesn't reach a span's
 * `startTime` arithmetic or the ClickHouse insert at all). */
const UINT32_MAX = 4_294_967_295;

/** A duration the client claims a hook took. Anything not a finite,
 * non-negative integer within the UInt32 range (negative, NaN, Infinity, a
 * float, or absurdly large) is treated as NOT REPORTED rather than as a
 * literal value — the ingest boundary takes client-supplied JSON, and a bad
 * number reaching the ClickHouse insert (UInt64/UInt32 columns) or a span's
 * `startTime = endTime - duration` arithmetic fails the whole batch or
 * stretches the timeline axis for the entire session, not just one row. */
function validHookDurationMs(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= UINT32_MAX;
}

const ms = (iso: string | undefined): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Client-supplied token count that is safe to multiply by a price. */
const tokens = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

/** What one session's turns cost, after the server has filled in what the
 * capture client could not price. */
interface SessionCosting {
  /** Turn index → USD. A turn is absent when nothing could price it. */
  byTurnIndex: Map<number, number>;
  /** Session total, or null when no turn could be priced at all. */
  totalUsd: number | null;
}

/**
 * Price the session's assistant turns, server-side.
 *
 * The capture client prices turns against the model registry snapshot bundled
 * into the version of the CLI the developer happens to have installed. That
 * snapshot is frozen at publish time, so every model released after it prices
 * at null — and a null cost is indistinguishable downstream from a free
 * session. The ingest re-prices anything the client left unpriced, against the
 * registry this gateway was deployed with.
 *
 * That is BETTER than the client's snapshot, not current: the runtime refresh
 * cannot reach its CDN source today (see the note on CDN_BASE in
 * @repo/llm-costs), so the server's map is frozen at deploy time rather than
 * pulled fresh. A model newer than the running deploy still prices at null
 * here. Fixing the refresh is what closes that gap; this pass only narrows it
 * from "as old as the developer's CLI" to "as old as the last deploy".
 *
 * Pricing is cache-aware. Cache-read carries most of the input volume on a
 * coding agent at a tenth of the input rate, so the cache-blind
 * `pricingData`/`costForTokens` path used elsewhere in the gateway would
 * overstate these turns by roughly an order of magnitude — it must not be
 * substituted here.
 *
 * A client-supplied cost always wins over a recomputed one: the client saw the
 * provider's own usage record, and some adapters (codex) reconcile per-turn
 * approximations against an exact session total we cannot reconstruct.
 */
function priceSession(session: AgentSession, priceMap: TokenPricingDictionary): SessionCosting {
  const byTurnIndex = new Map<number, number>();
  let sum = 0;
  let priced = false;
  let repriced = false;

  for (const turn of session.turns) {
    if (turn.role !== "assistant") continue;
    let cost: number | null = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    if (cost === null && typeof turn.model === "string" && turn.usage) {
      const price = resolveModelPrice(turn.model, priceMap);
      if (price) {
        const u = turn.usage as Record<string, unknown>;
        cost = costForUsage(price, {
          in: tokens(u.in),
          out: tokens(u.out),
          cacheRead: tokens(u.cacheRead),
          cacheCreate: tokens(u.cacheCreate),
        });
        repriced = true;
      }
    }
    if (cost === null || !Number.isFinite(cost) || cost < 0) continue;
    byTurnIndex.set(turn.index, cost);
    sum += cost;
    priced = true;
  }

  // The client's session total is authoritative only while the client priced
  // every turn it could — that total is what the codex scaling below reconciles
  // against. The moment we fill in a turn the client priced at null, its total
  // is missing that turn and our own sum is the complete figure.
  const clientTotal =
    typeof session.totals.costUsd === "number" && Number.isFinite(session.totals.costUsd)
      ? session.totals.costUsd
      : null;
  if (!repriced && clientTotal !== null) return { byTurnIndex, totalUsd: clientTotal };
  return { byTurnIndex, totalUsd: priced ? sum : clientTotal };
}

export interface AgentSpanOptions {
  /** Developer-seat identity (membership id — never an email). */
  actorId: string;
  /** Tier actually enforced (stamped onto every row). */
  tier: CaptureTier;
  /** Resolved run origin (see resolveWorkerKind). */
  workerKind: WorkerKind;
  /** Cache-aware price map used to fill in turns the capture client could not
   * price. Defaults to the gateway's live map (bundled snapshot, refreshed
   * from the CDN on cold start); injected in tests. */
  tokenPricing?: TokenPricingDictionary;
}

export function agentSessionToNormalizedSpans(session: AgentSession, opts: AgentSpanOptions): NormalizedSpan[] {
  const traceId = traceIdForSession(session.id);
  const rootSpanId = spanIdForPath(traceId, "session");

  // toolUseId → its tool call's span id, computed with the SAME path formula
  // the tool-call loop below uses (`turn:<index>:call:<seq>`, seq reset per
  // turn) — a pre-pass rather than a second loop, so a hook span (built
  // before the tool spans exist below) can still parent to one. A wrapped
  // Pre/PostToolUse execution carries the tool call's own id (persisted onto
  // `ToolCall.toolUseId` at parse time), letting the hook bar render directly
  // under the tool call it wrapped instead of the session root.
  const toolSpanIdByToolUseId = new Map<string, string>();
  for (const turn of session.turns) {
    turn.toolCalls.forEach((call, seq) => {
      if (typeof call.toolUseId === "string") {
        toolSpanIdByToolUseId.set(call.toolUseId, spanIdForPath(traceId, `turn:${turn.index}:call:${seq}`));
      }
    });
  }

  // Per-turn costs can be approximations (codex's usage stream overshoots its
  // own cumulative total 5–40%). The session total IS exact — scale per-turn
  // costs so SUM(Cost) over the trace equals it; proportions stay.
  const costing = priceSession(session, opts.tokenPricing ?? modelsTokenPricing);
  const turnCostSum = [...costing.byTurnIndex.values()].reduce((a, c) => a + c, 0);
  const sessionCost = costing.totalUsd;
  const costScale = sessionCost !== null && turnCostSum > 0 ? sessionCost / turnCostSum : 1;
  const startMs = ms(session.startedAt) || Date.parse("1970-01-01T00:00:00.000Z");
  const endMs = ms(session.endedAt) || startMs;

  // repo/branch/commit ride EVERY span's metadata (not just root) so
  // GROUP BY branch/repo attributes turn-span cost correctly
  const gitRepo = typeof session.env.gitRepo === "string" ? session.env.gitRepo : "";
  const gitBranch = typeof session.env.gitBranch === "string" ? session.env.gitBranch : "";
  const commitSha = typeof session.env.commitSha === "string" ? session.env.commitSha : "";
  // workerKind rides EVERY span (like repo/branch): it's a work-shaped
  // dimension the fleet dashboards may group turn-span cost by
  const spanMeta = (extra: Record<string, string>): Record<string, string> => ({
    ...(gitRepo ? { gitRepo } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(commitSha ? { commitSha } : {}),
    workerKind: opts.workerKind,
    ...extra,
  });
  const metadata: Record<string, string> = {
    agentType: session.agent.type,
    schemaVersion: String(session.schemaVersion),
    captureTier: opts.tier,
    workerKind: opts.workerKind,
  };
  if (session.agent.version) metadata.agentVersion = session.agent.version;
  if (session.agent.entrypoint) metadata.agentEntrypoint = session.agent.entrypoint;
  if (session.agent.origin) metadata.agentOrigin = session.agent.origin;
  if (session.env.gitBranch) metadata.gitBranch = session.env.gitBranch;
  if (session.env.gitRepo) metadata.gitRepo = session.env.gitRepo;
  if (session.env.cwd) metadata.cwd = session.env.cwd;
  if (session.title) metadata.title = session.title;
  // pr-link outcome rides the ROOT span only (trace views); the queryable
  // copy lives on agent_session_summary. Tier-safe: callers pass the gated
  // session, and `outcome` is redacted-tier.
  const rootOutcome = prOutcome(session);
  if (rootOutcome.prNumber) metadata.prNumber = String(rootOutcome.prNumber);
  if (rootOutcome.prUrl) metadata.prUrl = rootOutcome.prUrl;
  // The full link set — every PR with its per-PR commit attribution — rides
  // the root span (bounded); the flat queryable arrays live on
  // agent_session_summary, which cannot carry the per-PR sha mapping.
  if (rootOutcome.prs.length > 0) metadata.prLinks = JSON.stringify(rootOutcome.prs.slice(0, 20));
  if (session.subagent?.parentSessionId) metadata.parentSessionId = session.subagent.parentSessionId;
  if (session.subagent?.agentId) metadata.subagentId = session.subagent.agentId;

  const base = {
    traceId,
    resourceAttributes: { "service.name": "outerlayer-agent" } as Record<string, unknown>,
    links: [] as NormalizedSpan["links"],
    serviceName: "outerlayer-agent",
    sessionId: session.id,
  };

  const spans: NormalizedSpan[] = [];

  // root: the session itself. No tokens/cost here — turns carry them, and
  // SUM(Cost) GROUP BY SessionId must count each dollar exactly once.
  spans.push({
    ...base,
    spanId: rootSpanId,
    type: SpanType.SPAN,
    startTime: startMs,
    endTime: endMs,
    duration: Math.max(0, endMs - startMs),
    name: "agent.session",
    kind: "SPAN_KIND_INTERNAL",
    statusCode: "1",
    traceName: session.title ?? `agent session ${session.id.slice(0, 8)}`,
    metadata: { ...metadata },
    spanAttributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": session.agent.type,
      "gen_ai.conversation.id": session.id,
    },
    events: session.events.map((e) => ({
      timestamp: ms(e.ts as string | undefined) || startMs,
      name: e.type,
      attributes: (e.data as Record<string, unknown>) ?? {},
    })),
  });

  // Hook executions become child spans, not just root-span events — durations
  // render on the shared timeline axis exactly like tool calls, so a 13s hook
  // shows up as a wide bar instead of discarded event bytes. A wrapped
  // Pre/PostToolUse execution parents to the tool span it ran around (via
  // `toolSpanIdByToolUseId` above); everything else — an unresolved id, or a
  // transcript-derived Stop-hook summary, which Claude Code never times
  // per-tool-call — parents to root. `hookEvent` defaults to "Stop" for a
  // session synced before this field existed.
  for (const event of session.events) {
    if (event.type !== EVENT_TYPES.hookExecuted) continue;
    const data = (event.data ?? {}) as {
      hooks?: { command?: string; durationMs?: number; toolUseId?: string }[];
      hookEvent?: string;
      /** Set on a transcript-derived Stop-hook summary, where one id covers
       * every hook in the batch. A wrapped hook instead carries its own id
       * per entry (`hooks[].toolUseId`, checked first below). */
      toolUseId?: string;
      errorCount?: number;
    };
    // Cap re-applied server-side: session events are client-supplied JSON,
    // so the server can't assume the client's own parser cap was honored.
    const hooks = Array.isArray(data.hooks) ? data.hooks.slice(0, HOOK_ENTRIES_CAP) : [];
    // A session synced before the parser carried per-hook detail has
    // `hookCount` but no `hooks` array — it contributes zero spans here, a
    // known undercount, not a bug (re-syncing the transcript backfills it).
    if (hooks.length === 0) continue;
    const hookEvent = data.hookEvent ?? "Stop";
    const spanName: string = HOOK_SPAN_NAMES[hookEvent] ?? "agent.hook.stop";
    // the summary line's ts is when the hooks FINISHED — end-anchor the span
    // and derive start from duration, rather than guessing a start time.
    const endTime = ms(event.ts as string | undefined) || startMs;
    // errorCount is content-free (redacted-tier, via `data`) so failure stays
    // visible even when the raw text below is gated away. errorText is
    // full-tier and may be absent at redacted/metrics — statusCode still
    // flips to error, just without a message to show.
    const hasErrors = typeof data.errorCount === "number" && data.errorCount > 0;
    const errorText = Array.isArray(event.errorText) ? (event.errorText as string[]) : [];
    // Errors aren't attributed to a specific hook in the transcript, so every
    // hook from an event with any error renders red with the full error text —
    // a passing hook can show as failed when a sibling hook in the same
    // summary line errored. Unavoidable without per-hook attribution upstream.
    hooks.forEach((hook, i) => {
      const reported = validHookDurationMs(hook.durationMs);
      // never fabricate 0 as a real duration on the timeline — an unreported
      // hook renders as a zero-width marker, flagged so the UI can show "—"
      // instead of a misleading "0ms".
      const rawDuration = reported ? hook.durationMs! : 0;
      // A hook can claim a valid (≤ UInt32) but still-implausible duration
      // longer than the session has existed — never let its derived start
      // precede the session root's, which would stretch the whole timeline
      // axis for a bar that never really happened before the session began.
      // Recompute duration from the clamped start so the rendered bar and
      // the stored Duration column always agree.
      const startTime = Math.max(startMs, endTime - rawDuration);
      const duration = endTime - startTime;
      // Per-entry id wins over the event-level one (a wrapped hook's own id
      // is more precise than the batch id a Stop summary carries). Absent or
      // unresolved — the tool call it names isn't in this session, or there
      // is no id at all — root-parents rather than guessing by timestamp
      // proximity, which would mis-parent exactly the interesting cases
      // (parallel tool-call bursts, a hang with a pathological timestamp).
      const toolUseId = hook.toolUseId ?? data.toolUseId;
      const parentSpanId = (toolUseId && toolSpanIdByToolUseId.get(toolUseId)) || rootSpanId;
      spans.push({
        ...base,
        spanId: spanIdForPath(traceId, `hook:${event.seq}:${i}`),
        parentSpanId,
        type: SpanType.SPAN,
        startTime,
        endTime,
        duration,
        name: spanName,
        kind: "SPAN_KIND_INTERNAL",
        statusCode: hasErrors ? "2" : "1",
        // errorText may be empty here even when hasErrors is true — it's
        // full-tier and gated away below full, so the status still flips but
        // there's no message to show. Never fall back to raw data.errorCount
        // as a fake message; absent is more honest than a fabricated string.
        ...(errorText.length > 0 ? { statusMessage: errorText.join("; ").slice(0, 500) } : {}),
        metadata: spanMeta({
          hookEvent,
          ...(hook.command ? { hookCommand: hook.command } : {}),
          ...(toolUseId ? { toolUseId } : {}),
          // Present only when an id existed but named a tool call outside
          // this session — the "not linked" case the UI tooltip explains;
          // absence of BOTH fields means there was no id at all.
          ...(toolUseId && parentSpanId === rootSpanId ? { toolUseIdUnresolved: "1" } : {}),
          ...(reported ? {} : { durationUnreported: "1" }),
        }),
        spanAttributes: {
          "gen_ai.conversation.id": session.id,
        },
        events: [],
      });
    });
  }

  // synthetic monotonic timing when turns lack timestamps: 1ms per step keeps
  // the waterfall ordered without inventing meaningful-looking durations
  let cursor = startMs;
  for (const turn of session.turns) {
    const turnStart = ms(turn.ts as string | undefined) || cursor + 1;
    cursor = Math.max(cursor + 1, turnStart);
    const turnPath = `turn:${turn.index}`;
    const turnSpanId = spanIdForPath(traceId, turnPath);
    const isAssistant = turn.role === "assistant";
    const usage = turn.usage;

    spans.push({
      ...base,
      spanId: turnSpanId,
      parentSpanId: rootSpanId,
      type: isAssistant ? SpanType.GENERATION : SpanType.SPAN,
      startTime: cursor,
      endTime: cursor + (turn.durationMs ?? 0),
      duration: turn.durationMs ?? 0,
      name: `agent.turn.${turn.role}`,
      kind: "SPAN_KIND_INTERNAL",
      statusCode: "1",
      ...(isAssistant && turn.model ? { model: turn.model } : {}),
      ...(isAssistant && usage
        ? {
            // UNCACHED input only — the shared row builder prices InputTokens
            // at the full rate (cache-blind); cache counts
            // ride spanAttributes and TotalTokens carries the true volume
            inputTokens: usage.in,
            outputTokens: usage.out,
            totalTokens: usage.in + usage.cacheRead + usage.cacheCreate + usage.out,
          }
        : {}),
      ...(isAssistant && costing.byTurnIndex.has(turn.index)
        ? { cost: costing.byTurnIndex.get(turn.index)! * costScale }
        : {}),
      ...(turn.role === "user" && turn.text
        ? { input: [{ role: "user", content: asText(turn.text) }] as NormalizedSpan["input"] }
        : {}),
      ...(isAssistant && turn.text ? { output: asText(turn.text) } : {}),
      metadata: spanMeta({
        turnIndex: String(turn.index),
        // image refs ride the turn span (sha256 + mediaType); the bytes are
        // offloaded separately (R2 in prod / agent_blobs in dev) and served
        // by sha256 — the span never carries base64
        ...(Array.isArray(turn.images) && turn.images.length
          ? { images: JSON.stringify((turn.images as { sha256: string; mediaType: string; bytes?: number }[]).map((i) => ({ sha256: i.sha256, mediaType: i.mediaType, bytes: i.bytes }))) }
          : {}),
      }),
      spanAttributes: {
        // Machine-readable operation per the GenAI semconv registry: assistant
        // turns are inference calls ("chat"); user turns have no defined
        // operation and carry none. Span NAMES stay house vocabulary — the
        // attribute is the interop signal.
        ...(isAssistant ? { "gen_ai.operation.name": "chat" } : {}),
        // Turn provenance rides the user-turn span so a full-tier session stays
        // server-side recomputable (re-derive the human-steering count from
        // spans) and the UI can tell a developer prompt from relayed peer/
        // notification traffic. Unclassified turns (other adapters) read human.
        ...(turn.role === "user" ? { agentTurnSource: turn.source ?? "human" } : {}),
        "gen_ai.conversation.id": session.id,
        // Reasoning CONTENT has no semconv key (only reasoning token counts
        // do) — it rides our own namespace, never squatting on gen_ai.*.
        ...(turn.thinking ? { "outerlayer.reasoning": turn.thinking } : {}),
        // Official cache-token keys (semconv registry, Development).
        ...(usage
          ? {
              "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
              "gen_ai.usage.cache_creation.input_tokens": usage.cacheCreate,
            }
          : {}),
      },
      events: [],
    });

    let seq = 0;
    for (const call of turn.toolCalls) {
      const callPath = `${turnPath}:call:${seq}`;
      const callStart = cursor + seq + 1;
      spans.push({
        ...base,
        spanId: spanIdForPath(traceId, callPath),
        parentSpanId: turnSpanId,
        type: SpanType.SPAN,
        startTime: callStart,
        endTime: callStart + (call.durationMs ?? 0),
        duration: call.durationMs ?? 0,
        name: `agent.tool.${call.name}`,
        kind: "SPAN_KIND_INTERNAL",
        statusCode: call.status === "error" ? "2" : "1",
        ...(call.status === "error" && call.errorSignature ? { statusMessage: call.errorSignature } : {}),
        ...(call.input ? { input: [{ role: "user", content: asText(call.input) }] as NormalizedSpan["input"] } : {}),
        ...(call.output ? { output: asText(call.output) } : {}),
        metadata: spanMeta({
          turnIndex: String(turn.index),
          toolName: call.name,
          toolStatus: call.status,
          ...(call.isEdit ? { isEdit: "1" } : {}),
          ...(call.file ? { file: call.file } : {}),
        }),
        spanAttributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": call.name,
          "gen_ai.conversation.id": session.id,
        },
        events: [],
      });
      seq += 1;
    }
  }

  return spans;
}

// ---------------------------------------------------------------------------
// the full pipeline: gate → scrub → map → rows (+ agent columns)
// ---------------------------------------------------------------------------

export interface AgentIngestOptions {
  meta: UserMeta;
  actorId: string;
  /** Tenant-configured ceiling (default per spec: "redacted"). */
  tenantTier: CaptureTier;
  pricingData?: PricingData;
  /** See {@link AgentSpanOptions.tokenPricing}. */
  tokenPricing?: TokenPricingDictionary;
}

export type AgentClickHouseRow = ReturnType<typeof normalizedSpanToClickHouseRow> & {
  ActorId: string;
  CaptureTier: string;
  AgentType: string;
};

/**
 * AgentSession → otel_traces rows, gates applied. The single entry point the
 * sync endpoint (and the dev loader) call.
 */
export function agentSessionToClickHouseRows(session: AgentSession, opts: AgentIngestOptions): AgentClickHouseRow[] {
  const tier = effectiveTier(session.captureTier as CaptureTier, opts.tenantTier);
  // AgentSession is a zod loose object (string-indexed), so it satisfies the
  // JsonRecord constraint directly — T flows through, no casting
  const gated = downconvertSession(session, tier);
  const scrubbed = scrubSession(gated);
  const workerKind = resolveWorkerKind(session, opts.actorId);
  const spans = agentSessionToNormalizedSpans(scrubbed, {
    actorId: opts.actorId,
    tier,
    workerKind,
    ...(opts.tokenPricing ? { tokenPricing: opts.tokenPricing } : {}),
  });
  return spans.map((span) => {
    const row = normalizedSpanToClickHouseRow(span, opts.meta, opts.pricingData);
    // The shared builder recomputes cost from tokens when model+tokens are
    // present — cache-blind, which misprices cache-dominated agent sessions
    // by an order of magnitude. Our span.cost is the cache-aware, total-scaled
    // truth: force it, and keep the attribute mirror consistent.
    const cost = span.cost ?? 0;
    row.Cost = cost;
    if (row.SpanAttributes && typeof row.SpanAttributes === "object") {
      const attrs = row.SpanAttributes as Record<string, unknown>;
      if (span.cost !== undefined) attrs["outerlayer.cost"] = cost;
    }
    return {
      ...row,
      ActorId: opts.actorId,
      CaptureTier: tier,
      AgentType: session.agent.type,
    };
  });
}

export interface AgentSessionSummaryRow {
  TenantId: string;
  AppId: string;
  TraceId: string;
  SessionId: string;
  /** '' for a top-level session; the parent's SessionId for a subagent row. */
  ParentSessionId: string;
  /** How the session was initiated: `interactive`, `agent`, or '' for rows
   * ingested before the parser classified origin. */
  Origin: string;
  Title: string;
  AgentType: string;
  ActorId: string;
  WorkerKind: string;
  GitRepo: string;
  GitBranch: string;
  CommitSha: string;
  /** Last-linked PR — the scalar view of `PrNumbers`. */
  PrNumber: number;
  PrUrl: string;
  /** EVERY PR the session linked; `PrUrls` is index-aligned ('' when a link
   * had no url). Attribution reads the union of these and the scalar, so
   * rows predating the arrays keep attributing. */
  PrNumbers: number[];
  PrUrls: string[];
  OutcomeCommitShas: string[];
  CaptureTier: string;
  StartedAt: string;
  EndedAt: string;
  TurnCount: number;
  /** User (human) turns in the session. The first is the initial task hand-off;
   * UserTurnCount > 1 means a human had to step in mid-session (steering). */
  UserTurnCount: number;
  ToolCallCount: number;
  ErrorCount: number;
  /** Tool calls a human denied at the permission prompt (`status: rejected`).
   * Disjoint from ErrorCount, which counts tools that ran and failed. */
  RejectedToolCallCount: number;
  /** `permission_prompt` session events — times the agent had to stop and ask. */
  PermissionPromptCount: number;
  /** `api_error` session events — provider-side failures, not agent behavior. */
  ApiErrorCount: number;
  /** Hook executions across all `hook_executed` events: transcript-derived
   * Stop hooks plus any PreToolUse/PostToolUse hook wrapped via `hooks wrap`.
   * An unwrapped Pre/PostToolUse hook still undercounts here — the transcript
   * itself never records its timing at all. */
  HookExecutionCount: number;
  /** Sum of REPORTED hook durations only. A hook that doesn't report timing
   * (a self-backgrounding process, ~40% of executions in the wild) is
   * excluded here, not counted as zero — see HookUnreportedCount. */
  HookDurationMs: number;
  /** Hook executions with no reported duration, out of HookExecutionCount. */
  HookUnreportedCount: number;
  SlowestHookMs: number;
  /** Command of the slowest REPORTED hook; '' when no hook reported a duration. */
  SlowestHookCommand: string;
  CostUsd: number;
  Models: string[];
}

/** One PR the session linked, sanitized for persistence. */
export interface PrLinkEntry {
  prNumber: number;
  prUrl: string;
  commitShas: string[];
}

/** Bounded, string-only, 64-char-capped sha list (sha256 = 64, so a real
 * hash never truncates; abbreviated git hashes pass through as prefixes). */
function sanitizeShas(v: unknown, cap: number): string[] {
  return Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string")
        .slice(0, cap)
        .map((s) => s.slice(0, 64))
    : [];
}

/**
 * PR/commit outcome (`pr-link` lines). `outcome` is redacted-tier in
 * FIELD_TIERS, so callers must pass the DOWNCONVERTED session — a metrics-tier
 * write keeps the zero defaults. Urls are scrubbed (remotes can embed
 * credentials) and capped.
 *
 * A session can link MANY PRs: `prs` is the complete sanitized set (bounded).
 * The scalar `prNumber`/`prUrl` mirror the session's scalar outcome, falling
 * back to the last array entry; a scalar-only producer surfaces through the
 * array view as a single entry — so `prs` is ALWAYS the authoritative set and
 * readers of either contract see consistent data.
 */
function prOutcome(session: AgentSession): {
  prNumber: number;
  prUrl: string;
  commitShas: string[];
  prs: PrLinkEntry[];
} {
  const oc = session.outcome;
  const scrubUrl = (u: unknown): string => (typeof u === "string" ? scrubText(u).slice(0, 500) : "");
  const prs: PrLinkEntry[] = (Array.isArray(oc?.prs) ? oc.prs : [])
    .filter((p) => !!p && typeof p.prNumber === "number" && Number.isInteger(p.prNumber) && p.prNumber > 0)
    .slice(0, 50)
    .map((p) => ({ prNumber: p.prNumber, prUrl: scrubUrl(p.prUrl), commitShas: sanitizeShas(p.commitShas, 100) }));
  const n = oc?.prNumber;
  const scalarN = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
  const scalarUrl = scrubUrl(oc?.prUrl);
  if (prs.length === 0 && scalarN > 0) prs.push({ prNumber: scalarN, prUrl: scalarUrl, commitShas: [] });
  // Session-wide sha union: the producer's own union when present, else derived
  // from the per-PR sets — OutcomeCommitShas must cover every linked commit.
  let commitShas = sanitizeShas(oc?.commitShas, 100);
  if (commitShas.length === 0) {
    const seen = new Set<string>();
    for (const p of prs) {
      for (const sha of p.commitShas) {
        if (!seen.has(sha)) {
          seen.add(sha);
          commitShas.push(sha);
        }
      }
    }
    commitShas = commitShas.slice(0, 100);
  }
  const last = prs[prs.length - 1];
  return {
    prNumber: scalarN || (last?.prNumber ?? 0),
    prUrl: scalarUrl || (last?.prUrl ?? ""),
    commitShas,
    prs,
  };
}

const chDateTime = (iso: string | undefined, fallback: string): string => {
  const t = iso ? Date.parse(iso) : NaN;
  // ClickHouse DateTime64 wants 'YYYY-MM-DD HH:MM:SS.mmm'
  return new Date(Number.isFinite(t) ? t : Date.parse(fallback)).toISOString().replace("T", " ").replace("Z", "");
};

/**
 * One flat summary row per session — the sessions LIST reads THIS (a bounded
 * scan) instead of grouping the whole span table. Tier-gated + scrubbed the
 * same way as the spans (the title/branch are content-adjacent). GitRepo is
 * the app scope key; Title is always populated (parser guarantees it).
 */
export function agentSessionSummaryRow(session: AgentSession, opts: AgentIngestOptions): AgentSessionSummaryRow {
  const tier = effectiveTier(session.captureTier as CaptureTier, opts.tenantTier);
  const gated = downconvertSession(session, tier);
  const s = scrubSession(gated);
  const toolCalls = s.turns.flatMap((t) => t.toolCalls);
  const title = typeof s.title === "string" && s.title ? s.title : shortRepoName(session);
  // from the GATED session — a metrics-tier row must not carry the PR link
  const outcome = prOutcome(s);
  const hooks = hookStats(s.events);
  const startedAt = chDateTime(s.startedAt, "1970-01-01T00:00:00.000Z");
  // Same pass the span tree runs, so the rollup and SUM(Cost) over the trace
  // agree — the list reads this row and the detail reads the spans.
  const cost = priceSession(s, opts.tokenPricing ?? modelsTokenPricing).totalUsd;
  return {
    TenantId: opts.meta.tenantId ?? "",
    AppId: opts.meta.appId ?? "",
    TraceId: traceIdForSession(session.id),
    SessionId: session.id,
    ParentSessionId: typeof session.subagent?.parentSessionId === "string" ? session.subagent.parentSessionId : "",
    Origin: typeof session.agent.origin === "string" ? session.agent.origin : "",
    Title: title.slice(0, 200),
    AgentType: session.agent.type,
    ActorId: opts.actorId,
    WorkerKind: resolveWorkerKind(session, opts.actorId),
    GitRepo: typeof session.env.gitRepo === "string" ? session.env.gitRepo : "",
    GitBranch: typeof session.env.gitBranch === "string" ? session.env.gitBranch : "",
    CommitSha: typeof session.env.commitSha === "string" ? session.env.commitSha : "",
    PrNumber: outcome.prNumber,
    PrUrl: outcome.prUrl,
    PrNumbers: outcome.prs.map((p) => p.prNumber),
    PrUrls: outcome.prs.map((p) => p.prUrl),
    OutcomeCommitShas: outcome.commitShas,
    CaptureTier: tier,
    StartedAt: startedAt,
    EndedAt: chDateTime(s.endedAt as string | undefined, s.startedAt),
    // A chunked part carries whole-session counts (identical on every part,
    // so each part's summary row is byte-identical → replace is a no-op);
    // an unchunked session derives them from its turns as before.
    TurnCount: session.chunk?.counts.turns ?? s.turns.length,
    // Human-authored turns. A chunked part carries the whole-session count when
    // the producer supplies it; otherwise count this part's user turns (exact
    // for the common unchunked case).
    UserTurnCount: session.chunk?.counts.userTurns ?? s.turns.filter(isHumanUserTurn).length,
    ToolCallCount: session.chunk?.counts.toolCalls ?? toolCalls.length,
    ErrorCount: session.chunk?.counts.errors ?? toolCalls.filter((c) => c.status === "error").length,
    // Steering signals: tool `status` and event `type` are metrics-tier, so no
    // tier guard — every capture tier carries them.
    RejectedToolCallCount:
      session.chunk?.counts.rejectedToolCalls ?? toolCalls.filter((c) => c.status === "rejected").length,
    PermissionPromptCount:
      session.chunk?.counts.permissionPrompts ?? s.events.filter((e) => e.type === "permission_prompt").length,
    ApiErrorCount: session.chunk?.counts.apiErrors ?? s.events.filter((e) => e.type === "api_error").length,
    HookExecutionCount: hooks.count,
    HookDurationMs: hooks.durationMs,
    HookUnreportedCount: hooks.unreportedCount,
    SlowestHookMs: hooks.slowestMs,
    SlowestHookCommand: hooks.slowestCommand,
    // Micro-dollar precision, not cents: a short subagent turn on a cheap model
    // costs a fraction of a cent, and cents-rounding stored that as a literal
    // 0 — indistinguishable from "we could not price this session" — while
    // making SUM(CostUsd) over a fleet lose up to half a cent per session.
    CostUsd: cost === null ? 0 : Math.round(cost * 1e6) / 1e6,
    Models: Array.isArray(s.models) ? (s.models as string[]) : [],
  };
}

/** Rollup over every `hook_executed` event's `data.hooks` entries. Reads the
 * gated + scrubbed session, so the command it surfaces is tier-correct and
 * scrubbed by construction — never a second scrub pass on this string. */
function hookStats(events: AgentSession["events"]): {
  count: number;
  durationMs: number;
  unreportedCount: number;
  slowestMs: number;
  slowestCommand: string;
} {
  let count = 0;
  let durationMs = 0;
  let unreportedCount = 0;
  let slowestMs = 0;
  let slowestCommand = "";
  for (const event of events) {
    if (event.type !== EVENT_TYPES.hookExecuted) continue;
    const rawHooks = (event.data as { hooks?: { command?: string; durationMs?: number }[] } | undefined)?.hooks;
    if (!Array.isArray(rawHooks)) continue;
    // Same server-side cap as the span loop — this rollup sums client-supplied
    // JSON, so an unbounded array here would let one event skew the summary
    // row as badly as it would skew the span count.
    const hooks = rawHooks.slice(0, HOOK_ENTRIES_CAP);
    for (const hook of hooks) {
      count += 1;
      if (validHookDurationMs(hook.durationMs)) {
        // validHookDurationMs already bounds this at UINT32_MAX, so slowestMs
        // never needs a second clamp here.
        durationMs += hook.durationMs;
        if (hook.durationMs > slowestMs) {
          slowestMs = hook.durationMs;
          slowestCommand = typeof hook.command === "string" ? hook.command : "";
        }
      } else {
        unreportedCount += 1;
      }
    }
  }
  return { count, durationMs, unreportedCount, slowestMs, slowestCommand };
}

/** Last two segments of the repo/cwd — a last-resort title when a session has
 * no ask (should be rare now the parser always derives one). */
function shortRepoName(session: AgentSession): string {
  const p = (typeof session.env.gitRepo === "string" && session.env.gitRepo) || (typeof session.env.cwd === "string" && session.env.cwd) || "session";
  return p.split("/").filter(Boolean).slice(-2).join("/");
}
