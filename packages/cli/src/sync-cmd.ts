// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer sync`: scan local coding-agent sessions since
 * the last sync checkpoint, tier-downconvert CLIENT-SIDE, and POST batches to
 * the OuterLayer cloud (`POST /v1/agents/sync`) with API-key auth.
 *
 * Privacy stance:
 *  - The tier is applied BEFORE anything leaves the machine (parse-level via
 *    `captureTier` + an explicit `downconvertSession` belt). The server clamps
 *    again to the tenant ceiling; the client clamp is what `--dry-run` shows.
 *  - `--dry-run` prints exactly what WOULD leave: per-session rows, blob
 *    bytes, and the field classes stripped at the chosen tier. With `--json`
 *    it emits the exact request payloads. Zero network calls either way.
 *
 * Checkpointing: the local SQLite store's meta table records a per-destination
 * watermark (max transcript mtime successfully synced). A session that grows
 * after a sync has a newer mtime and re-syncs whole — deterministic ids make
 * that idempotent server-side. Transport failures stop the run WITHOUT
 * advancing the watermark past the failed batch; schema rejects are permanent
 * (re-sending identical bytes cannot fix them) and do not hold it back.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  scanAll,
  enrichSessionRepo,
  resolveRepoIdentity,
  SOURCE_ADAPTERS,
  type SourceAdapter,
  type CapturedBlob,
} from "@outerlayer/capture";
import {
  downconvertSession,
  bannedPathsForTier,
  inferArtifactKind,
  isHumanUserTurn,
  CAPTURE_TIERS,
  type AgentSession,
  type CaptureTier,
  type EmitArtifactRequest,
  type Turn,
} from "@outerlayer/session-schema";
import { scrubDeep, setCustomScrubbers, setLocalIdentity, setRepoRoot, type CustomScrubConfig } from "@outerlayer/capture";
import { writeSyncStatus } from "./sync-status.js";
import { readWatermark, writeWatermark } from "./watermark.js";
import { planHookExecMerge, appendHookExecEvents, writeHookExecWatermark } from "./hook-exec-merge.js";
import {
  ARTIFACT_RETRY_MAX_AGE_MS,
  artifactBlobsDir,
  planArtifactUpload,
  readArtifactRecordsSince,
  readUploadedArtifactIds,
  resolveArtifactTurnIndex,
  writeArtifactsWatermark,
  writeUploadedArtifactIds,
} from "./artifact-spool.js";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { RepoFilter, type RepoFilterConfig } from "./repo-filter.js";

// ---------------------------------------------------------------------------
// cloud config (~/.outerlayer/config.json)
// ---------------------------------------------------------------------------

export interface CloudConfig {
  url?: string;
  apiKey?: string;
  appId?: string;
  /** Scope which repos may sync — see repo-filter.ts for semantics. */
  repos?: RepoFilterConfig;
  /** Hook-triggered background sync. Default true when config exists. */
  autoSync?: boolean;
  /** Capture tier for syncs that don't pass --tier. Default "full". */
  tier?: string;
  /** Additive custom scrubbers (literals + regex patterns). */
  scrub?: CustomScrubConfig;
}

export function cloudConfigPath(home = homedir()): string {
  return join(home, ".outerlayer", "config.json");
}

export function readCloudConfig(home = homedir()): CloudConfig {
  const path = cloudConfigPath(home);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CloudConfig;
  } catch {
    return {};
  }
}

/**
 * Merges into the stored config rather than replacing it.
 *
 * Partial writes are the norm here — the credential auto-persist knows only
 * `{url, apiKey, appId}` — and a whole-file replace silently discards every
 * field it does not know about: `repos`, `autoSync`, `tier`, `scrub`. That
 * turns a routine credential refresh into an invisible loss of someone's repo
 * filter and custom scrubbers, which fails OPEN (sessions that were meant to
 * be excluded start shipping). An explicit `undefined` never erases a stored
 * value; remove a key by editing the file.
 */
export function writeCloudConfig(config: CloudConfig, home = homedir()): void {
  const path = cloudConfigPath(home);
  const merged: Record<string, unknown> = { ...readCloudConfig(home) };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) merged[key] = value;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // `mode` on writeFileSync applies only when the file is CREATED — an
  // existing config keeps whatever permissions it had, and this one holds an
  // API key. chmod every write so a file created by hand is tightened too.
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort: a filesystem that cannot chmod must not fail the sync
  }
}

/**
 * True for a destination that only exists on the machine that typed it.
 *
 * Such a URL is a deliberate one-off — someone testing a gateway they are
 * running locally — but the background sync passes NO flags and reads whatever
 * was last persisted. Saving it silently redirects every later sync into a
 * port that stops listening the moment the test ends, and the failures are
 * invisible because the hook discards them.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^127\./.test(host)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// options / result
// ---------------------------------------------------------------------------

/** True inside a CI pipeline — the convention every major CI exports `CI=true`
 * (GitHub Actions, GitLab CI, CircleCI, Buildkite, Travis); Jenkins predates it,
 * hence the extra probe. Exported for tests. */
export function detectCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || !!env.JENKINS_URL;
}

/** Server-mirrored batch caps (gateway MAX_SESSIONS_PER_SYNC = 50). */
const MAX_SESSIONS_PER_BATCH = 25;
/** Server-mirrored: gateway MAX_BLOBS_PER_SYNC = 64 — a request with more is
 * rejected 400, so batching must also flush on deduped blob count. */
const MAX_BLOBS_PER_BATCH = 64;
/** Blobs also need a BYTE budget, not just a count: screenshot-heavy sessions
 * average ~170 KB per image, so 64 of them clear 10 MB and 413 against the
 * gateway's 8 MB request ceiling. Count alone cannot bound that, and the
 * adaptive split recovers by SESSION count — powerless on a one-session batch.
 * Sized to leave MAX_BATCH_JSON_BYTES of session payload under the ceiling. */
const MAX_BLOB_BYTES_PER_BATCH = 4_000_000;
/** A single blob at or above the per-batch budget can never be packed, so it
 * never ships: its ref stays intact and the bytes stay local. */
const MAX_SINGLE_BLOB_BYTES = MAX_BLOB_BYTES_PER_BATCH;
/** Soft cap on a serialized batch (bytes of JSON) — stays far under Workers limits. */
const MAX_BATCH_JSON_BYTES = 3_500_000;
/** A session serializing over this ships as CHUNK PARTS (schema `chunk`
 * envelope). Two ceilings force this: the gateway 413s whole requests above
 * its byte limit, and the ingest Worker's per-request CPU budget — parse +
 * scrub + span-mapping scale with content, so a single dense multi-MB
 * session 503s deterministically ("Worker exceeded resource limits"). */
const SESSION_CHUNK_TRIGGER_BYTES = 1_000_000;
/** Target serialized size per chunk part — sized so one part's ingest work
 * fits the Worker CPU budget with headroom: dense multi-MB sessions exceed
 * that budget, sub-MB parts do not. */
const CHUNK_PART_TARGET_BYTES = 700_000;
/** A single tool call's serialized input/output above this is sliced before
 * chunking — one pathological tool result must never make a part unshippable. */
const MAX_TOOL_IO_CHARS = 64_000;

interface CollectedItem {
  session: AgentSession;
  blobs: CapturedBlob[];
  mtimeMs: number;
}

/** Slice a tool call's oversized serialized input/output (string → sliced with
 * a marker; structured → stringified then sliced). Content-lossy by design,
 * bounded so a single pathological tool result can't sink a whole session. */
function sliceToolIo(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string" || text.length <= MAX_TOOL_IO_CHARS) return value;
  return `${text.slice(0, MAX_TOOL_IO_CHARS)}…[sliced: ${text.length} chars exceeded the sync per-call cap]`;
}

function sliceTurnIo(turn: Turn): Turn {
  return {
    ...turn,
    toolCalls: (turn.toolCalls ?? []).map((call) => ({
      ...call,
      ...(call.input !== undefined ? { input: sliceToolIo(call.input) } : {}),
      ...(call.output !== undefined ? { output: sliceToolIo(call.output) } : {}),
    })),
  };
}

/** The blobs a part must carry: every sha its turns reference. Refs live on
 * `turn.images` (the parser records every extracted image there, including
 * tool-result screenshots). */
function blobsForTurns(blobs: CapturedBlob[], turns: Turn[]): CapturedBlob[] {
  const shas = new Set<string>();
  for (const t of turns) for (const img of t.images ?? []) shas.add(img.sha256);
  return blobs.filter((b) => shas.has(b.sha256));
}

/**
 * Split a session whose serialized form exceeds the request budget into
 * schema `chunk` parts: each part is a complete session envelope (identical
 * outcome/title/events/totals — the ingest converter requires part-invariant
 * root content) carrying a SUBSET of turns plus exactly the blobs those turns
 * reference. `counts` are WHOLE-session numbers, identical on every part.
 * Sessions under the trigger pass through untouched.
 */
function chunkOversizedSession(item: CollectedItem): CollectedItem[] {
  if (JSON.stringify(item.session).length <= SESSION_CHUNK_TRIGGER_BYTES) return [item];
  const turns: Turn[] = (item.session.turns as Turn[]) ?? [];
  const allCalls = turns.flatMap((t) => t.toolCalls ?? []);
  const counts = {
    turns: turns.length,
    toolCalls: allCalls.length,
    errors: allCalls.filter((c) => c.status === "error").length,
    userTurns: turns.filter(isHumanUserTurn).length,
  };
  const envelopeBytes = JSON.stringify({ ...item.session, turns: [] }).length;
  const budget = Math.max(CHUNK_PART_TARGET_BYTES - envelopeBytes, 100_000);
  const parts: Turn[][] = [];
  let cur: Turn[] = [];
  let curBytes = 0;
  for (const raw of turns) {
    let turn = raw;
    let bytes = JSON.stringify(turn).length + 1;
    if (bytes > budget) {
      turn = sliceTurnIo(raw);
      bytes = JSON.stringify(turn).length + 1;
    }
    if (cur.length > 0 && curBytes + bytes > budget) {
      parts.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(turn);
    curBytes += bytes;
  }
  if (cur.length > 0) parts.push(cur);
  return parts.map((partTurns, i) => ({
    session: {
      ...item.session,
      turns: partTurns,
      chunk: { part: i + 1, of: parts.length, counts },
    } as AgentSession,
    blobs: blobsForTurns(item.blobs, partTurns),
    mtimeMs: item.mtimeMs,
  }));
}

// Transient server states a long backfill WILL hit (measured: staging 503s
// after ~a dozen back-to-back 3.5MB batches). Retried per batch with
// exponential backoff; the watermark already makes re-sends idempotent.
// 429 is deliberately NOT here: ours is the monthly ingest cap, not
// throttling — backing off can't fix it, and its message must fail fast.
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
/** Per-batch attempts (1 initial + 5 retries ≈ 62s of total backoff). */
const MAX_BATCH_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 2_000;

export interface SyncCommandOptions {
  /** Cloud base URL (flag > OUTERLAYER_URL > config file). */
  url?: string;
  /** API key (flag > OUTERLAYER_API_KEY > config file). */
  apiKey?: string;
  /** App id the key is bound to (flag > OUTERLAYER_APP_ID > config file). */
  appId?: string;
  /** Capture tier applied client-side before anything leaves. Default: redacted. */
  tier?: CaptureTier;
  /** Print what would leave the machine; make zero network calls. */
  dryRun?: boolean;
  /** Machine-readable output (with dryRun: the exact request payloads). */
  json?: boolean;
  /** Ignore the checkpoint and sync everything. */
  all?: boolean;
  limit?: number;
  // Source roots (mirror `scan`)
  root?: string;
  rawRoot?: string;
  codexRoot?: string;
  cursorRoot?: string;
  cursorProjectsRoot?: string;
  home?: string;
  quiet?: boolean;
  /** Injectable transport (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (tests). Default: setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface SyncRejected {
  index: number;
  id?: string;
  reason: string;
}

export interface SyncCommandResult {
  scanned: number;
  eligible: number;
  synced: number;
  rejected: SyncRejected[];
  blobsSent: number;
  batches: number;
  tier: CaptureTier;
  url: string;
  dryRun: boolean;
  /** New watermark (ms) after this run, when one was persisted. */
  watermarkMs?: number;
  output: string;
}

interface SyncBatchPayload {
  schemaVersion: 1;
  sessions: Record<string, unknown>[];
  blobs?: CapturedBlob[];
}

/**
 * Halve a batch that the server keeps refusing (repeated retryable 5xx, or a
 * 413): per-request work scales with content, so shrinking the request is the
 * only move that converges. Blobs partition by which half's turns reference
 * them; a blob referenced by both halves ships in both (content-addressed,
 * idempotent), and an orphaned one rides the first half.
 */
function splitPayload(payload: SyncBatchPayload): [SyncBatchPayload, SyncBatchPayload] {
  const mid = Math.ceil(payload.sessions.length / 2);
  const first = payload.sessions.slice(0, mid);
  const second = payload.sessions.slice(mid);
  const shasOf = (sessions: Record<string, unknown>[]): Set<string> => {
    const set = new Set<string>();
    for (const s of sessions) {
      const turns = (s as { turns?: { images?: { sha256?: unknown }[] }[] }).turns ?? [];
      for (const t of turns) for (const img of t.images ?? []) if (typeof img.sha256 === "string") set.add(img.sha256);
    }
    return set;
  };
  const firstShas = shasOf(first);
  const secondShas = shasOf(second);
  const blobs = payload.blobs ?? [];
  const firstBlobs = blobs.filter((b) => firstShas.has(b.sha256) || !secondShas.has(b.sha256));
  const secondBlobs = blobs.filter((b) => secondShas.has(b.sha256));
  return [
    { schemaVersion: 1, sessions: first, ...(firstBlobs.length > 0 ? { blobs: firstBlobs } : {}) },
    { schemaVersion: 1, sessions: second, ...(secondBlobs.length > 0 ? { blobs: secondBlobs } : {}) },
  ];
}

export class SyncConfigError extends Error {}
export class SyncTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SyncTransportError";
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveTier(raw: string | undefined): CaptureTier {
  // Content is the product (2026-07-15): full is the default everywhere.
  // Lower tiers remain available per-sync (--tier) or per-machine (config).
  if (raw === undefined) return "full";
  if ((CAPTURE_TIERS as readonly string[]).includes(raw)) return raw as CaptureTier;
  throw new SyncConfigError(`unknown tier "${raw}" — use ${CAPTURE_TIERS.join(" | ")}`);
}


/** Wrap every source adapter so discovery skips transcripts at or below the
 * checkpoint — filtered BEFORE parse, so an incremental sync never pays the
 * full-corpus parse cost. */
function sinceAdapters(sinceMs: number): SourceAdapter[] {
  return SOURCE_ADAPTERS.map((adapter) => ({
    ...adapter,
    discover: (roots) => adapter.discover(roots).filter((entry) => entry.mtimeMs > sinceMs),
  }));
}

/** Human bytes. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Spool-record strings (filename, session id) are attacker-influenceable —
 * the schema allows any short string, and a hand-tampered spool line or a
 * file deliberately named with ANSI escape bytes would otherwise inject
 * terminal escape sequences into the operator's terminal on output. */
function sanitizeTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Coarse age for pending-artifact rows — just enough to spot a stuck record. */
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/** Mutable run stats, populated as the run progresses so the status record
 * can describe a run that THREW — the failing case is the one worth
 * describing, and by then the return value no longer exists. */
interface SyncRunStats {
  url?: string;
  appId?: string;
  synced?: number;
  pending?: number;
}

/**
 * Records every run's outcome to `~/.outerlayer/last-sync.json` before
 * surfacing it. The hook-triggered sync discards stdout, stderr, and exit
 * code, so this file is the ONLY evidence that a background sync ran at all —
 * `doctor` and the SessionStart hook read it back.
 */
export async function runSync(opts: SyncCommandOptions = {}): Promise<SyncCommandResult> {
  const home = opts.home ?? homedir();
  const stats: SyncRunStats = {};
  try {
    const result = await runSyncInner(opts, stats);
    // A dry run ships nothing, so it is not evidence of a working pipe.
    if (!result.dryRun) {
      writeSyncStatus(
        {
          at: new Date().toISOString(),
          ok: true,
          url: result.url,
          appId: stats.appId,
          synced: result.synced,
          pending: 0,
        },
        home,
      );
    }
    return result;
  } catch (err) {
    writeSyncStatus(
      {
        at: new Date().toISOString(),
        ok: false,
        url: stats.url,
        appId: stats.appId,
        synced: stats.synced ?? 0,
        pending: stats.pending,
        error: {
          status: err instanceof SyncTransportError ? err.status : undefined,
          message: err instanceof Error ? err.message : String(err),
        },
      },
      home,
    );
    throw err;
  }
}

async function runSyncInner(opts: SyncCommandOptions, stats: SyncRunStats): Promise<SyncCommandResult> {
  const home = opts.home ?? homedir();
  const envVars = opts.env ?? process.env;
  const fileConfig = readCloudConfig(home);

  const url = opts.url ?? envVars.OUTERLAYER_URL ?? fileConfig.url;
  const apiKey = opts.apiKey ?? envVars.OUTERLAYER_API_KEY ?? fileConfig.apiKey;
  const appId = opts.appId ?? envVars.OUTERLAYER_APP_ID ?? fileConfig.appId;
  // Recorded before the config check below, so a status record written for a
  // misconfigured run still names the destination it was aiming at.
  stats.url = url;
  stats.appId = appId;
  const tier = resolveTier(opts.tier ?? envVars.OUTERLAYER_TIER ?? fileConfig.tier);
  const dryRun = opts.dryRun ?? false;
  const repoFilter = new RepoFilter(fileConfig.repos);
  // Identity + custom scrubbers install once per run; scrubDeep applies them
  // (with the built-in patterns) to every string that ships.
  setCustomScrubbers(fileConfig.scrub);
  const gitConfig = (key: string): string | undefined => {
    try {
      return execFileSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 2000 }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  setLocalIdentity({
    name: gitConfig("user.name"),
    email: gitConfig("user.email"),
    username: (() => { try { return userInfo().username; } catch { return undefined; } })(),
    hostname: (() => { try { return hostname(); } catch { return undefined; } })(),
    home,
  });

  if (!url || !apiKey || !appId) {
    const missing = [!url && "--url", !apiKey && "--api-key", !appId && "--app-id"].filter(Boolean).join(", ");
    throw new SyncConfigError(
      `missing ${missing}. Pass flags, set OUTERLAYER_URL / OUTERLAYER_API_KEY / OUTERLAYER_APP_ID, ` +
        `or save them to ${cloudConfigPath(home)}. Mint a key in the dashboard: Settings → API keys.`,
    );
  }

  {
    // The checkpoint is a JSON file, not the SQLite mirror: the sync hot path
    // must not load a native module to read one number. sub-ms mtime precision
    // is preserved (the checkpoint stores the raw double), so the last-synced
    // transcript is never re-marked eligible. A fresh machine migrates its
    // prior SQLite watermark once inside readWatermark.
    const sinceMs = opts.all ? 0 : readWatermark(url, appId, home);

    // -----------------------------------------------------------------------
    // hook-wrap spool → hook_executed events, merged into whichever sessions
    // below actually get scanned this run. Read ONCE up front (not per
    // session) — the reader state machine resolves the whole spool window in
    // one pass; see hook-exec-merge.ts for the watermark contract (only
    // advances past a session's records once that session is actually
    // merged, so one behind the OTHER, mtime-based watermark isn't lost).
    // -----------------------------------------------------------------------
    const hookPlan = planHookExecMerge({ home });
    const mergedHookSessionIds = new Set<string>();

    // Artifact spool, snapshotted at the same point: records emitted DURING
    // this run land after the snapshot and simply wait for the next sync.
    const artifactPlan = planArtifactUpload({ home });

    // -----------------------------------------------------------------------
    // collect eligible sessions (streaming; tier applied at parse AND after)
    // -----------------------------------------------------------------------
    const collected: Array<{ session: AgentSession; blobs: CapturedBlob[]; mtimeMs: number }> = [];
    const { report } = scanAll({
      root: opts.root,
      rawRoot: opts.rawRoot,
      codexRoot: opts.codexRoot,
      cursorRoot: opts.cursorRoot,
      cursorProjectsRoot: opts.cursorProjectsRoot,
      limit: opts.limit,
      captureTier: tier,
      adapters: sinceAdapters(sinceMs),
      onSession: (session, entry, blobs) => {
        enrichSessionRepo(session);
        // Install this session's working-tree root (resolved from its absolute
        // cwd) so the upcoming scrub strips it, rendering in-repo paths
        // repo-relative. Per session — worktrees/multiple repos differ; cleared
        // when a session has no repo.
        setRepoRoot(resolveRepoIdentity(session.env.cwd).repoRoot);
        // Repo scoping BEFORE anything is collected: a filtered session never
        // reaches a batch. The watermark still advances past it (documented
        // in repo-filter.ts) — loosening the filter later needs `sync --all`.
        if (!repoFilter.allows((session as { env?: { gitRepo?: string } }).env?.gitRepo)) return;
        // Merge any resolved hook-wrap executions for THIS session before
        // scrub/tier-gating, so a hook command's text is scrubbed and
        // down-converted exactly like everything else (`events[].data` is
        // already `redacted`-tiered — no new FIELD_TIERS entry needed).
        const hookEvents = hookPlan.eventsBySession.get(session.id);
        if (hookEvents && hookEvents.length > 0) {
          appendHookExecEvents(session, hookEvents);
          mergedHookSessionIds.add(session.id);
        }
        // Always-on secret scrubbing — every tier, not configurable. Runs
        // BEFORE the tier gate so full-content uploads are scrubbed and lower
        // tiers strip already-scrubbed text (belt over belt).
        scrubDeep(session);
        // Run-origin attribution: a local sync is a developer seat
        // unless we're inside a CI pipeline. Metrics-safe, survives the gate.
        session.workerKind ??= detectCi(envVars) ? "ci" : "seat";
        // Belt over the parse-level tier: strips anything an adapter let
        // through and stamps `captureTier` — this exact object is what ships.
        const gated = downconvertSession(session as unknown as Record<string, unknown>, tier);
        collected.push({
          session: gated as unknown as AgentSession,
          blobs: tier === "full" ? blobs : [],
          mtimeMs: entry.mtimeMs,
        });
      },
    });

    // A session whose hook events resolved this run but that itself never got
    // scanned (filtered out, or still behind the SEPARATE transcript-mtime
    // watermark) must hold the hook-exec watermark behind its earliest
    // resolved record — otherwise those events are gone for good the moment
    // this run's watermark commits, with no future run able to re-derive them.
    let hookWatermarkOffset = hookPlan.fullyConsumedOffset;
    for (const [sessionId, offset] of hookPlan.sessionGroupOffsets) {
      if (!mergedHookSessionIds.has(sessionId)) hookWatermarkOffset = Math.min(hookWatermarkOffset, offset);
    }

    // Everything collected is pending until a batch carrying it is accepted.
    stats.pending = collected.length;

    // Oldest first: the watermark can only ever advance past FULLY-shipped work.
    collected.sort((a, b) => a.mtimeMs - b.mtimeMs);
    // Oversized sessions become chunk parts AFTER ordering — parts stay
    // adjacent, so a partially-shipped session re-sends whole on resume.
    const items = collected.flatMap((item) => chunkOversizedSession(item));

    // -----------------------------------------------------------------------
    // batch (count + serialized-size caps, blobs deduped within a batch)
    // -----------------------------------------------------------------------
    const batches: Array<{ payload: SyncBatchPayload; maxMtimeMs: number }> = [];
    {
      let current: SyncBatchPayload = { schemaVersion: 1, sessions: [] };
      let currentBlobs = new Map<string, CapturedBlob>();
      let currentBytes = 0;
      let currentBlobBytes = 0;
      let currentMax = 0;
      const flush = (): void => {
        if (current.sessions.length === 0) return;
        if (currentBlobs.size > 0) current.blobs = [...currentBlobs.values()];
        batches.push({ payload: current, maxMtimeMs: currentMax });
        current = { schemaVersion: 1, sessions: [] };
        currentBlobs = new Map();
        currentBytes = 0;
        currentBlobBytes = 0;
        currentMax = 0;
      };
      for (const item of items) {
        const size = JSON.stringify(item.session).length + item.blobs.reduce((n, b) => n + b.data.length, 0);
        // Dedupe-aware blob accounting: only shas NEW to the current batch
        // count toward the server's per-request blob cap.
        let newBlobs = item.blobs.filter((b) => !currentBlobs.has(b.sha256));
        const newBlobBytes = newBlobs.reduce((n, b) => n + b.data.length, 0);
        if (
          current.sessions.length >= MAX_SESSIONS_PER_BATCH ||
          (currentBytes > 0 && currentBytes + size > MAX_BATCH_JSON_BYTES) ||
          (current.sessions.length > 0 && currentBlobs.size + newBlobs.length > MAX_BLOBS_PER_BATCH) ||
          (current.sessions.length > 0 && currentBlobBytes + newBlobBytes > MAX_BLOB_BYTES_PER_BATCH)
        ) {
          flush();
          newBlobs = item.blobs.filter((b) => !currentBlobs.has(b.sha256));
        }
        // A single session can reference more images than one request may
        // carry — by count OR by bytes. Pack what fits and drop the rest:
        // the session still ingests and every image ref stays intact, the
        // overflow just has no fetchable bytes. Dropping is the only option
        // that terminates — a batch too big to ship and too small to split
        // (one session) would otherwise 413 forever, blocking the watermark
        // and every later session behind it.
        const packed: CapturedBlob[] = [];
        let packedBytes = currentBlobBytes;
        for (const blob of newBlobs) {
          if (currentBlobs.size + packed.length >= MAX_BLOBS_PER_BATCH) break;
          if (blob.data.length >= MAX_SINGLE_BLOB_BYTES) continue;
          if (packedBytes + blob.data.length > MAX_BLOB_BYTES_PER_BATCH) continue;
          packed.push(blob);
          packedBytes += blob.data.length;
        }
        if (packed.length < newBlobs.length) {
          process.stderr.write(
            `${YELLOW}!${RESET} session ${(item.session as { id?: string }).id ?? "?"} references ${newBlobs.length} images (${Math.round(newBlobBytes / 1024)} KB) — shipping ${packed.length}, the rest stay local\n`,
          );
        }
        current.sessions.push(item.session as unknown as Record<string, unknown>);
        for (const blob of packed) if (!currentBlobs.has(blob.sha256)) currentBlobs.set(blob.sha256, blob);
        currentBytes += size;
        currentBlobBytes = packedBytes;
        currentMax = Math.max(currentMax, item.mtimeMs);
      }
      flush();
    }

    const blobsTotal = batches.reduce((n, b) => n + (b.payload.blobs?.length ?? 0), 0);
    const blobBytes = batches.reduce(
      (n, b) => n + (b.payload.blobs?.reduce((m, blob) => m + blob.bytes, 0) ?? 0),
      0,
    );

    // -----------------------------------------------------------------------
    // dry run — the privacy gate. Print exactly what leaves; touch nothing.
    // -----------------------------------------------------------------------
    if (dryRun) {
      let output: string;
      if (opts.json) {
        output = JSON.stringify(
          {
            url,
            appId,
            tier,
            batches: batches.map((b) => b.payload),
            artifacts: {
              pending: artifactPlan.records.length,
              records: artifactPlan.records.map(({ record }) => ({
                filename: record.filename,
                kind: inferArtifactKind(record.mediaType),
                sessionId: record.sessionId,
                emittedAt: record.t,
              })),
            },
          },
          null,
          2,
        );
      } else {
        const lines: string[] = [];
        lines.push(`${YELLOW}DRY RUN${RESET} — nothing left this machine.`);
        lines.push("");
        lines.push(`  destination  ${url} ${DIM}(app ${appId})${RESET}`);
        lines.push(`  tier         ${tier}`);
        const stripped = bannedPathsForTier(tier);
        lines.push(
          stripped.length > 0
            ? `  stripped     ${DIM}${stripped.join(", ")}${RESET}`
            : `  stripped     ${DIM}nothing — full content ships${RESET}`,
        );
        lines.push(`  sessions     ${collected.length} (of ${report.scanned} scanned) in ${batches.length} batch(es)`);
        lines.push(`  images       ${blobsTotal} blob(s), ${fmtBytes(blobBytes)}`);
        if (artifactPlan.records.length > 0) {
          lines.push(`  artifacts    ${artifactPlan.records.length} pending upload`);
          for (const { record } of artifactPlan.records.slice(0, 10)) {
            lines.push(
              `    ${DIM}${sanitizeTerminal(record.sessionId).slice(0, 8)}${RESET}  ${inferArtifactKind(record.mediaType)}  ${sanitizeTerminal(record.filename)}  ${DIM}${fmtAge(Date.now() - Date.parse(record.t))}${RESET}`,
            );
          }
          if (artifactPlan.records.length > 10) {
            lines.push(`    ${DIM}… and ${artifactPlan.records.length - 10} more${RESET}`);
          }
        }
        const byRepo = new Map<string, number>();
        for (const item of collected) {
          const r = (item.session as unknown as { env?: { gitRepo?: string } }).env?.gitRepo || "(no repo)";
          byRepo.set(r, (byRepo.get(r) ?? 0) + 1);
        }
        const repoRows = [...byRepo.entries()].sort((a, b) => b[1] - a[1]);
        lines.push(`  repos        ${repoRows.length} distinct:`);
        for (const [r, n] of repoRows.slice(0, 15)) lines.push(`    ${DIM}${String(n).padStart(6)}${RESET}  ${r}`);
        if (repoRows.length > 15) lines.push(`    ${DIM}… and ${repoRows.length - 15} more${RESET}`);
        if (repoFilter.skippedTotal > 0) {
          lines.push(`  ${YELLOW}skipped${RESET}      ${repoFilter.skippedTotal} session(s) by repo filter:`);
          for (const [r, n] of [...repoFilter.skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
            lines.push(`    ${DIM}${String(n).padStart(6)}${RESET}  ${r}`);
          }
        }
        lines.push("");
        for (const item of collected.slice(0, 20)) {
          const s = item.session as unknown as {
            id: string;
            agent: { type: string };
            env?: { gitRepo?: string; gitBranch?: string };
            startedAt?: string;
            turns: unknown[];
          };
          const repo = s.env?.gitRepo ? ` ${s.env.gitRepo}${s.env.gitBranch ? `@${s.env.gitBranch}` : ""}` : "";
          lines.push(
            `  ${DIM}${s.id.slice(0, 8)}${RESET}  ${s.agent.type}  ${s.startedAt ?? "?"}  ${s.turns.length} turns${repo}`,
          );
        }
        if (collected.length > 20) lines.push(`  ${DIM}… and ${collected.length - 20} more${RESET}`);
        lines.push("");
        lines.push(`Run again without --dry-run to sync.`);
        output = lines.join("\n");
      }
      if (!opts.quiet) process.stdout.write(output + "\n");
      return {
        scanned: report.scanned,
        eligible: collected.length,
        synced: 0,
        rejected: [],
        blobsSent: 0,
        batches: batches.length,
        tier,
        url,
        dryRun: true,
        output,
      };
    }

    // -----------------------------------------------------------------------
    // ship
    // -----------------------------------------------------------------------
    const fetchImpl = opts.fetchImpl ?? fetch;
    const endpoint = new URL("/v1/agents/sync", url).toString();
    let synced = 0;
    let blobsSent = 0;
    const rejected: SyncRejected[] = [];
    let watermarkMs = sinceMs;
    let shippedBatches = 0;

    // Progress: a long backfill would otherwise be SILENT until it finished
    // or died. TTY gets a live overwritten line; non-TTY (CI, pipes) gets a
    // line every 25 batches. Progress goes to stderr so stdout stays the
    // machine-readable summary.
    const progress = (final = false): void => {
      if (opts.quiet || opts.json || batches.length <= 1) return;
      const msg = `  batch ${shippedBatches}/${batches.length} · ${synced} session(s) synced`;
      if (process.stderr.isTTY) {
        process.stderr.write(`\r${msg}${final ? "\n" : ""}`);
      } else if (final || shippedBatches % 25 === 0) {
        process.stderr.write(`${msg}\n`);
      }
    };
    // On ANY mid-run failure: say exactly what survived and that the
    // watermark saved it, so the resume path is visible without guessing.
    const failureContext = (): void => {
      if (opts.quiet || shippedBatches === 0) return;
      process.stderr.write(
        `\n${YELLOW}!${RESET} progress saved: ${synced} session(s) in ${shippedBatches}/${batches.length} batch(es) shipped before the failure — re-run ${DIM}outerlayer sync${RESET} to resume from there.\n`,
      );
    };

    const sleepImpl =
      opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // Ship queue: original batches advance the watermark; halves produced by
    // an adaptive split re-enter at the FRONT, and only the LAST half of an
    // original batch inherits its watermark-advance right — a resume must
    // never skip a half that hasn't shipped.
    const queue: Array<{ payload: SyncBatchPayload; maxMtimeMs: number; advance: boolean }> = batches.map(
      (b) => ({ payload: b.payload, maxMtimeMs: b.maxMtimeMs, advance: true }),
    );
    // The size the server has demonstrated it can take. Starts unbounded;
    // every capacity split lowers it, and later batches pre-split to it
    // WITHOUT burning a retry ladder first — one discovery, then cruise.
    // Never relaxes within a run; a fresh run starts unbounded again.
    let requestSessionCap = Number.POSITIVE_INFINITY;
    while (queue.length > 0) {
      const batch = queue.shift()!;
      if (batch.payload.sessions.length > requestSessionCap) {
        const [a, b] = splitPayload(batch.payload);
        queue.unshift(
          { payload: a, maxMtimeMs: batch.maxMtimeMs, advance: false },
          { payload: b, maxMtimeMs: batch.maxMtimeMs, advance: batch.advance },
        );
        continue;
      }
      let response: Response | undefined;
      let networkErr = "";
      for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
              "x-outerlayer-app-id": appId,
            },
            body: JSON.stringify(batch.payload),
          });
          networkErr = "";
        } catch (err) {
          response = undefined;
          networkErr = String(err);
        }
        if (response && !RETRYABLE_STATUSES.has(response.status)) break;
        if (attempt === MAX_BATCH_ATTEMPTS) break;
        // A Retry-After hint from the server wins over our own schedule.
        const retryAfterRaw = response?.headers.get("retry-after");
        const retryAfterMs =
          retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) * 1000 : 0;
        const delayMs = Math.max(retryAfterMs, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        if (!opts.quiet) {
          const cause = response ? `HTTP ${response.status}` : "network error";
          process.stderr.write(
            `\n${YELLOW}!${RESET} batch ${shippedBatches + 1}/${batches.length} hit ${cause} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_BATCH_ATTEMPTS})\n`,
          );
        }
        await sleepImpl(delayMs);
      }
      if (!response) {
        failureContext();
        throw new SyncTransportError(`network error reaching ${endpoint}: ${networkErr}`);
      }
      if (response.status === 401) {
        failureContext();
        throw new SyncTransportError(
          "not authorized — the API key is unknown, expired, or bound to a different app. Mint a fresh key: dashboard → Settings → API keys.",
          401,
        );
      }
      // Adaptive split: a batch the server keeps refusing for capacity
      // reasons — retries exhausted on a 5xx (e.g. a Worker resource-limit
      // 503, which is deterministic for a given payload) or an immediate
      // 413 — shrinks instead of killing the run. Halves re-enter the queue
      // front; a single session that still fails falls through to the
      // terminal error below.
      if (
        (RETRYABLE_STATUSES.has(response.status) || response.status === 413) &&
        batch.payload.sessions.length > 1
      ) {
        const [a, b] = splitPayload(batch.payload);
        requestSessionCap = Math.min(requestSessionCap, Math.max(a.sessions.length, b.sessions.length));
        if (!opts.quiet) {
          process.stderr.write(
            `\n${YELLOW}!${RESET} batch keeps failing (HTTP ${response.status}) — splitting into ${a.sessions.length}+${b.sessions.length} session request(s)\n`,
          );
        }
        queue.unshift(
          { payload: a, maxMtimeMs: batch.maxMtimeMs, advance: false },
          { payload: b, maxMtimeMs: batch.maxMtimeMs, advance: batch.advance },
        );
        continue;
      }
      if (!response.ok) {
        let detail = "";
        try {
          // Text-first: a platform-level failure (Cloudflare 5xx) sends an
          // HTML/plain body — surfacing its first line beats a bare status.
          const text = await response.text();
          try {
            const body = JSON.parse(text) as {
              error?: { message?: string; currentCount?: number; limit?: number; details?: { currentCount?: number; limit?: number } };
            };
            detail = body.error?.message ?? "";
            // The 429 payload carries the usage numbers — surface them.
            const usage = body.error?.details ?? body.error;
            if (response.status === 429 && typeof usage?.currentCount === "number" && typeof usage?.limit === "number") {
              detail += ` (${usage.currentCount.toLocaleString()}/${usage.limit.toLocaleString()} units used this month)`;
            }
          } catch {
            detail = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
          }
        } catch {
          /* unreadable error body */
        }
        failureContext();
        throw new SyncTransportError(`sync failed (${response.status})${detail ? `: ${detail}` : ""}`, response.status);
      }
      const body = (await response.json()) as {
        data: { accepted: string[]; rejected: SyncRejected[]; blobsStored: number };
      };
      synced += body.data.accepted.length;
      blobsSent += body.data.blobsStored;
      rejected.push(...body.data.rejected);
      // Keep the status record honest if a LATER batch throws: partial
      // progress is the difference between "nothing works" and "resume it".
      stats.synced = synced;
      stats.pending = Math.max(0, collected.length - synced);
      // The ORIGINAL batch is fully shipped (accepted or permanently
      // rejected) — the watermark may advance past it. A non-final half
      // never advances: its siblings are still in the queue.
      if (batch.advance) {
        watermarkMs = Math.max(watermarkMs, batch.maxMtimeMs);
        writeWatermark(url, appId, watermarkMs, home);
        shippedBatches += 1;
        progress(shippedBatches === batches.length);
      }
    }

    // -----------------------------------------------------------------------
    // spooled artifacts → POST /v1/artifacts, one per record, AFTER the
    // session batches (the gateway validates the session an artifact claims,
    // so that session must land first). Failures never fail the sync: a
    // record that can't upload holds the artifact watermark at its offset
    // (min-offset rule, like hook-exec's) and retries next run, until it is
    // older than ARTIFACT_RETRY_MAX_AGE_MS.
    // -----------------------------------------------------------------------
    let artifactWatermarkOffset = artifactPlan.fullyConsumedOffset;
    if (artifactPlan.records.length > 0) {
      const artifactEndpoint = new URL("/v1/artifacts", url).toString();
      const nowMs = Date.now();
      const previouslyUploaded = readUploadedArtifactIds(home);
      const uploadedIds = new Set<string>();
      const uploadedShas = new Set<string>();
      const deadShas = new Set<string>();
      const heldShas = new Set<string>();
      const warn = (message: string): void => {
        if (!opts.quiet) process.stderr.write(`${YELLOW}!${RESET} ${message}\n`);
      };
      // 401 short-circuits like the session loop's: a bad key fails every
      // record identically, so the rest hold for the next sync and the run
      // surfaces the same actionable auth error.
      let unauthorized: SyncTransportError | undefined;
      for (const { record, offset } of artifactPlan.records) {
        const name = sanitizeTerminal(record.filename);
        if (unauthorized) {
          heldShas.add(record.sha256);
          artifactWatermarkOffset = Math.min(artifactWatermarkOffset, offset);
          continue;
        }
        // A record whose upload already succeeded in an earlier run (its
        // offset stayed above the watermark only because an EARLIER record
        // failed) is re-read here, not re-uploaded — and its already-cleaned
        // blob must not be reported as a lost artifact.
        if (previouslyUploaded.has(record.artifactId)) {
          uploadedIds.add(record.artifactId);
          uploadedShas.add(record.sha256);
          continue;
        }
        let blobData: Buffer;
        try {
          blobData = readFileSync(join(artifactBlobsDir(home), record.sha256));
        } catch {
          warn(`artifact ${name}: blob missing from the spool — dropping the record`);
          continue;
        }
        // The owning session, if it was part of THIS scan — its tool-call
        // text locates the emitting turn. A session synced in an earlier run
        // uploads with no turnIndex; the server still validates the id.
        const owner = collected.find((c) => (c.session as { id?: string }).id === record.sessionId);
        const turnIndex = owner
          ? resolveArtifactTurnIndex((owner.session as { turns?: Turn[] }).turns ?? [], record.filename)
          : undefined;
        const request: EmitArtifactRequest = {
          schemaVersion: 1,
          artifact: {
            clientArtifactId: record.artifactId,
            filename: record.filename,
            mediaType: record.mediaType,
            bytes: record.bytes,
            sha256: record.sha256,
            caption: record.caption,
            ...(record.criterionId !== undefined ? { criterionId: record.criterionId } : {}),
            emittedAt: record.t,
            ...(record.prNumber !== undefined ? { prNumber: record.prNumber } : {}),
            ...(record.gitRepo !== undefined ? { gitRepo: record.gitRepo } : {}),
            ...(record.gitBranch !== undefined ? { gitBranch: record.gitBranch } : {}),
            ...(record.commitSha !== undefined ? { commitSha: record.commitSha } : {}),
            session: { sessionId: record.sessionId, ...(turnIndex !== undefined ? { turnIndex } : {}) },
          },
          blob: { data: blobData.toString("base64") },
        };
        let failure = "";
        let status: number | undefined;
        try {
          const response = await fetchImpl(artifactEndpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
              "x-outerlayer-app-id": appId,
            },
            body: JSON.stringify(request),
          });
          if (!response.ok) {
            failure = `HTTP ${response.status}`;
            status = response.status;
          }
        } catch (err) {
          failure = String(err);
        }
        if (!failure) {
          uploadedIds.add(record.artifactId);
          uploadedShas.add(record.sha256);
          continue;
        }
        if (status === 401) {
          unauthorized = new SyncTransportError(
            "not authorized — the API key is unknown, expired, or bound to a different app. Mint a fresh key: dashboard → Settings → API keys.",
            401,
          );
          heldShas.add(record.sha256);
          artifactWatermarkOffset = Math.min(artifactWatermarkOffset, offset);
          continue;
        }
        // A schema-level reject cannot be fixed by re-sending identical
        // bytes — mirror the session classification and mark the record
        // dead instead of re-POSTing it on every sync for 14 days. 408 and
        // 429 stay retryable: timeout and the monthly cap are transient.
        if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          warn(`artifact ${name} rejected permanently (${failure}) — dropping the record`);
          deadShas.add(record.sha256);
          continue;
        }
        const emittedMs = Date.parse(record.t);
        if (Number.isFinite(emittedMs) && nowMs - emittedMs > ARTIFACT_RETRY_MAX_AGE_MS) {
          warn(`artifact ${name} (${failure}) is older than 14 days and still failing — dropping it`);
          deadShas.add(record.sha256);
          continue;
        }
        warn(`artifact ${name} upload failed (${failure}) — will retry on the next sync`);
        heldShas.add(record.sha256);
        artifactWatermarkOffset = Math.min(artifactWatermarkOffset, offset);
      }
      // Blob cleanup, refcounted within the whole spool as it exists NOW: a
      // sha that uploaded may still be referenced by a held record, or by a
      // record a concurrent emit appended past this run's snapshot — either
      // one still needs the bytes, so the delete skips that sha and a later
      // sync (which sees zero pending references) reclaims it.
      const lateShas = new Set(
        readArtifactRecordsSince(home, artifactPlan.fullyConsumedOffset).records.map((r) => r.record.sha256),
      );
      for (const sha of [...uploadedShas, ...deadShas]) {
        if (heldShas.has(sha) || lateShas.has(sha)) continue;
        try {
          unlinkSync(join(artifactBlobsDir(home), sha));
        } catch {
          // already gone — content-addressed, nothing left to clean
        }
      }
      // Persist which uploads sit at or above the watermark being kept, so
      // the next run's re-read skips them. Records the watermark passes
      // never come back, so their ids age out of the set here.
      const keep = new Set<string>();
      for (const { record, offset } of artifactPlan.records) {
        if (offset >= artifactWatermarkOffset && uploadedIds.has(record.artifactId)) keep.add(record.artifactId);
      }
      writeUploadedArtifactIds(keep, home);
      if (unauthorized) {
        // The held offset must survive the throw — the writes at the end of
        // the run are never reached on this path.
        writeArtifactsWatermark(artifactWatermarkOffset, home);
        failureContext();
        throw unauthorized;
      }
    }

    // First successful sync with explicit flags → persist for next time, so
    // the background sync (which passes none) knows where to ship. A loopback
    // destination is deliberately NOT persisted: see isLoopbackUrl.
    if (shippedBatches === batches.length && (opts.url || opts.apiKey || opts.appId)) {
      if (isLoopbackUrl(url)) {
        if (!opts.quiet) {
          process.stderr.write(
            `${DIM}  not saving ${new URL(url).host} as the default destination — pass the flags again next time, or edit ${cloudConfigPath(home)}${RESET}\n`,
          );
        }
      } else {
        writeCloudConfig({ url, apiKey, appId }, home);
      }
    }

    let output: string;
    if (opts.json) {
      output = JSON.stringify({ scanned: report.scanned, eligible: collected.length, synced, rejected, blobsSent, tier, url });
    } else {
      const lines: string[] = [];
      const icon = rejected.length === 0 ? `${GREEN}✓${RESET}` : `${YELLOW}!${RESET}`;
      lines.push(
        `${icon} synced ${synced}/${collected.length} session(s) → ${new URL(url).host} ${DIM}(tier ${tier}${blobsSent ? `, ${blobsSent} image(s)` : ""}${repoFilter.skippedTotal > 0 ? `, ${repoFilter.skippedTotal} skipped by repo filter` : ""})${RESET}`,
      );
      if (collected.length === 0) {
        lines.push(`${DIM}  nothing new since the last sync — use --all to re-send everything${RESET}`);
      }
      for (const r of rejected.slice(0, 10)) {
        lines.push(`  ${RED}✗${RESET} ${r.id ?? `#${r.index}`} ${DIM}${r.reason}${RESET}`);
      }
      if (rejected.length > 10) lines.push(`  ${DIM}… and ${rejected.length - 10} more rejects${RESET}`);
      output = lines.join("\n");
    }
    if (!opts.quiet) process.stdout.write(output + "\n");

    // Commit only now: this line is reached solely after every batch shipped
    // without throwing (a mid-run failure re-derives the same, idempotent
    // events next time — see hook-exec-merge.ts). Never reached on --dry-run,
    // which returns above and must leave local state untouched.
    writeHookExecWatermark(hookWatermarkOffset, home);
    writeArtifactsWatermark(artifactWatermarkOffset, home);

    return {
      scanned: report.scanned,
      eligible: collected.length,
      synced,
      rejected,
      blobsSent,
      batches: batches.length,
      tier,
      url,
      dryRun: false,
      watermarkMs,
      output,
    };
  }
}
