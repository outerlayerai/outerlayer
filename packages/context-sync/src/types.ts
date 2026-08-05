/**
 * Public contract for the context mirror sync service. Route-level wiring
 * parallel to the link/push trigger sites — the concrete `ContextMirrorPort`
 * (Supabase) and `GitPort` (a provider) are supplied by the caller, never
 * constructed here, so the algorithm stays testable against fakes with no
 * Supabase and no real git calls.
 */

// -----------------------------------------------------------------------------
// Git port — the narrow slice of a git provider the sync algorithm needs. The
// dashboard's full `GitProvider` satisfies this structurally; keeping the port
// narrow is what lets this package live outside the app.
// -----------------------------------------------------------------------------

export interface GitTreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
  size: number;
  encoding: 'utf-8' | 'base64';
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  /** For renamed files. */
  previousPath?: string;
  additions: number;
  deletions: number;
  patch?: string;
  sha: string;
}

export interface GitPort {
  getLatestCommitSha(repo: string, branch: string): Promise<string | null>;
  listTree(repo: string, ref: string): Promise<GitTreeEntry[]>;
  getFileContent(repo: string, path: string, ref: string): Promise<FileContent>;
  compareCommits(repo: string, base: string, head: string): Promise<FileDiff[]>;
}

// -----------------------------------------------------------------------------
// Sync outcomes
// -----------------------------------------------------------------------------

export interface SyncOutcome {
  kind: 'advanced-only' | 'snapshotted' | 'resynced' | 'ignored' | 'failed';
  commitSha?: string;
  /**
   * The head snapshot the mirror points at after a successful attempt — the
   * newly created snapshot for a full/incremental sync, or the carried-forward
   * head snapshot when the tree did not change (advanced-only) or the push was
   * a no-op replay (ignored with a resolved commit). Absent for failures and
   * for wrong-branch ignores.
   */
  snapshotId?: string;
  error?: string;
}

export interface SyncOnPushInput {
  appId: string;
  tenantId: string;
  repo: string;
  branch: string;
  /** Null (mirroring NormalizedPushEvent.beforeSha) always forces a full resync. */
  beforeSha: string | null;
  afterSha: string;
  /** The head commit's message from the push payload, recorded on the event. */
  commitMessage: string | null;
}

export interface InitialSyncInput {
  appId: string;
  tenantId: string;
  repo: string;
  branch: string;
}

/** Manual resync of an app's connected branch (Context tab button). */
export type ResyncInput = InitialSyncInput;

/**
 * The general full-tree primitive: resolves `ref` to a commit sha, then
 * builds (or reuses, on an idempotent repeat) the snapshot for that sha.
 *
 * DESIGN INTENT: this one primitive later serves PR-branch views, env
 * pinning, and eval baselines — any future pointer type resolves a ref and
 * calls this. Do not specialize it to "head only": a `commitSha` ref must
 * materialize a snapshot WITHOUT moving `context_head` (see
 * `ContextMirrorPort.createSnapshot`'s nullable `branch`).
 */
export interface EnsureSnapshotAtInput {
  appId: string;
  tenantId: string;
  repo: string;
  ref: { branch: string } | { commitSha: string };
}

export interface ContextSync {
  syncOnPush(i: SyncOnPushInput): Promise<SyncOutcome>;
  initialSync(i: InitialSyncInput): Promise<SyncOutcome>;
  resync(i: ResyncInput): Promise<SyncOutcome>;
  ensureSnapshotAt(i: EnsureSnapshotAtInput): Promise<SyncOutcome>;
}

// -----------------------------------------------------------------------------
// Sync event ledger — self-recorded, one row per sync ATTEMPT.
// -----------------------------------------------------------------------------

export type SyncTrigger = 'link' | 'push' | 'resync';
export type SyncEventStatus = 'synced' | 'failed';

/**
 * One `context_sync_event` row. `commitSha` is null only when a failed attempt
 * dies before HEAD resolution; a synced event always carries the resolved sha
 * and the head snapshot it points at.
 */
export interface SyncEventInput {
  appId: string;
  tenantId: string;
  branch: string;
  commitSha: string | null;
  /** Head commit message (push only; NULL for link/resync). */
  commitMessage: string | null;
  trigger: SyncTrigger;
  status: SyncEventStatus;
  error: string | null;
  durationMs: number;
  snapshotId: string | null;
}

// -----------------------------------------------------------------------------
// ContextMirrorPort — narrow I/O boundary the algorithm is tested against with
// fakes (no Supabase in the unit test bar).
// -----------------------------------------------------------------------------

export interface ContextHeadRecord {
  branch: string;
  commitSha: string;
  snapshotId: string;
}

export interface BlobInput {
  blobSha: string;
  content: string;
  size: number;
}

export interface EntryInput {
  path: string;
  blobSha: string;
  kind: string;
  scopePath: string;
}

/** Per-skill count of non-content files present in git but not mirrored. */
interface ExcludedCountInput {
  scopePath: string;
  skillName: string;
  count: number;
}

export interface CreateSnapshotInput {
  appId: string;
  tenantId: string;
  /** Null for a bare-sha materialization (never moves context_head). */
  branch: string | null;
  commitSha: string;
  classifierVersion: number;
  blobs: BlobInput[];
  entries: EntryInput[];
  /** From classifyTree over the FULL git tree — the tree's "N other files in git" annotation. */
  excludedCounts: ExcludedCountInput[];
}

export interface AdvanceHeadInput {
  appId: string;
  tenantId: string;
  branch: string;
  commitSha: string;
  /** The snapshot to keep — advancing the commit sha with no context
   *  changes reuses the existing snapshot rather than creating a new one. */
  snapshotId: string;
}

export interface ContextMirrorPort {
  /** The single connected-branch head for an app, or null if never synced. */
  loadHead(appId: string): Promise<ContextHeadRecord | null>;
  /** Bare paths in a snapshot — the `applySnapshotChanges` parent-paths input. */
  getSnapshotPaths(snapshotId: string): Promise<string[]>;
  hasBlob(appId: string, blobSha: string): Promise<boolean>;
  /** Atomic multi-table write via `create_context_snapshot` (SQL function). */
  createSnapshot(input: CreateSnapshotInput): Promise<{ snapshotId: string }>;
  /** Single-table pointer move — no new snapshot (context unchanged). */
  advanceHead(input: AdvanceHeadInput): Promise<void>;
  /** Append one row to the `context_sync_event` ledger (self-reporting). */
  recordSyncEvent(event: SyncEventInput): Promise<void>;
}
