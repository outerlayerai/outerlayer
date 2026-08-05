/**
 * Context mirror sync algorithm. All classification and diff decisions are
 * pure calls into `@repo/context-core`; this file is the I/O orchestration
 * around them — testable against fake `ContextMirrorPort` / `GitPort`
 * implementations (no Supabase, no real git calls).
 *
 * Each public trigger (initialSync=link, syncOnPush=push, resync) records
 * exactly one `context_sync_event` per attempt through the db port. The shared
 * `ensureSnapshotAt` primitive does NOT record — the push self-heal path calls
 * it internally, and double-recording would break the one-row-per-attempt
 * contract.
 */
import { CLASSIFIER_VERSION, applySnapshotChanges, classifyTree, hasContextChanges } from '@repo/context-core';
import type { TreeChange } from '@repo/context-core';
import type {
  BlobInput,
  ContextMirrorPort,
  ContextSync,
  EntryInput,
  EnsureSnapshotAtInput,
  FileDiff,
  GitPort,
  InitialSyncInput,
  ResyncInput,
  SyncEventInput,
  SyncOnPushInput,
  SyncOutcome,
  SyncTrigger,
} from './types';

/**
 * Blob content above this size is not mirrored (oversize guard) — the tree
 * entry is still written (it references a `blob_sha` with no corresponding
 * `context_blob` row, which the schema allows by design), but the UI fetches
 * oversize content on demand from git instead.
 */
const OVERSIZE_BYTES = 1_048_576; // 1 MiB

function diffToTreeChange(diff: FileDiff): TreeChange {
  return { path: diff.path, status: diff.status, previousPath: diff.previousPath };
}

export function createContextSync(deps: { db: ContextMirrorPort; git: GitPort }): ContextSync {
  const { db, git } = deps;

  /**
   * Resolves `ref` to a commit sha, lists the FULL tree at that sha in one
   * bulk call, classifies it (context-core drops everything outside
   * `.outerlayer/`/root instruction files), and fetches content only for
   * blobs not already mirrored (`hasBlob` — content-addressing makes a
   * repeat resync cheap). Always a full-tree rebuild — the `'resynced'`
   * outcome kind, whether called directly (initial sync, resync) or as the
   * self-heal path inside `syncOnPush`. Does NOT record an event; the calling
   * trigger owns the single event per attempt.
   */
  async function ensureSnapshotAt(i: EnsureSnapshotAtInput): Promise<SyncOutcome> {
    // Track the resolved sha so a failure AFTER resolution can report it (a
    // failure BEFORE resolution leaves it null — the two failure pins).
    let commitSha: string | null = 'commitSha' in i.ref ? i.ref.commitSha : null;
    try {
      const branch = 'branch' in i.ref ? i.ref.branch : null;
      if (commitSha === null) {
        commitSha = await git.getLatestCommitSha(i.repo, (i.ref as { branch: string }).branch);
      }

      if (!commitSha) {
        return { kind: 'failed', error: `could not resolve ref for ${i.repo}` };
      }

      const tree = await git.listTree(i.repo, commitSha);
      const byPath = new Map(tree.map((e) => [e.path, e]));

      const { entries: classified, excludedCounts } = classifyTree(tree.map((e) => e.path));

      const blobs: BlobInput[] = [];
      const entries: EntryInput[] = [];

      for (const entry of classified) {
        const treeEntry = byPath.get(entry.path);
        if (!treeEntry) continue; // defensive: classifyTree only saw paths from byPath's keys
        entries.push({
          path: entry.path,
          blobSha: treeEntry.sha,
          kind: entry.kind,
          scopePath: entry.scopePath,
        });

        if (await db.hasBlob(i.appId, treeEntry.sha)) continue;

        // `size` from listTree is GitHub's reported blob size, real inline —
        // when known upfront, skip the content fetch entirely for an
        // already-oversize blob instead of fetching just to discard it.
        if (treeEntry.size > 0 && treeEntry.size > OVERSIZE_BYTES) continue;

        const file = await git.getFileContent(i.repo, entry.path, commitSha);
        if (file.size <= OVERSIZE_BYTES) {
          blobs.push({ blobSha: treeEntry.sha, content: file.content, size: file.size });
        }
      }

      const { snapshotId } = await db.createSnapshot({
        appId: i.appId,
        tenantId: i.tenantId,
        branch,
        commitSha,
        classifierVersion: CLASSIFIER_VERSION,
        blobs,
        entries,
        excludedCounts,
      });

      return { kind: 'resynced', commitSha, snapshotId };
    } catch (err) {
      return {
        kind: 'failed',
        commitSha: commitSha ?? undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function computePushOutcome(i: SyncOnPushInput): Promise<SyncOutcome> {
    try {
      const head = await db.loadHead(i.appId);

      // No head yet (initial sync never ran, or failed non-fatally) — bootstrap
      // via a full resync at the pushed branch.
      if (head === null) {
        return ensureSnapshotAt({
          appId: i.appId,
          tenantId: i.tenantId,
          repo: i.repo,
          ref: { branch: i.branch },
        });
      }

      // Push to a branch other than the one context is tracking — ignored (v1).
      // Branch reconnection is a separate, explicit future action.
      if (head.branch !== i.branch) {
        return { kind: 'ignored' };
      }

      // Duplicate/replayed webhook for a commit already synced — no-op, but the
      // mirror IS current, so surface the head snapshot for the synced event.
      if (i.afterSha === head.commitSha) {
        return { kind: 'ignored', commitSha: head.commitSha, snapshotId: head.snapshotId };
      }

      // Missed webhook, force push, or any other gap between the head we
      // have and the push's stated base — self-heal via full resync rather
      // than attempting to reconstruct the missing history.
      if (head.commitSha !== i.beforeSha) {
        return ensureSnapshotAt({
          appId: i.appId,
          tenantId: i.tenantId,
          repo: i.repo,
          ref: { branch: i.branch },
        });
      }

      const diffs = await git.compareCommits(i.repo, i.beforeSha, i.afterSha);
      const changes = diffs.map(diffToTreeChange);

      if (!hasContextChanges(changes)) {
        await db.advanceHead({
          appId: i.appId,
          tenantId: i.tenantId,
          branch: i.branch,
          commitSha: i.afterSha,
          snapshotId: head.snapshotId,
        });
        return { kind: 'advanced-only', commitSha: i.afterSha, snapshotId: head.snapshotId };
      }

      const parentPaths = await db.getSnapshotPaths(head.snapshotId);
      const nextPaths = applySnapshotChanges(parentPaths, changes);
      const { entries: classified } = classifyTree(nextPaths);

      // Only added/modified/renamed(-to) paths need fresh content — carried-
      // forward entries reuse their existing blob_sha (resolved below via one
      // bulk tree listing, no per-file fetch) and are never re-pushed into
      // `blobs` (their content already exists in `context_blob`, content-
      // addressed and immutable).
      const changedPaths = new Set(
        changes.filter((c) => c.status !== 'removed').map((c) => c.path)
      );

      // One bulk call resolves blob_sha for the WHOLE next-snapshot path
      // list (changed and carried-forward alike) — cheap relative to the
      // per-file `getFileContent` calls below, which are restricted to
      // `changedPaths` only.
      const tree = await git.listTree(i.repo, i.afterSha);
      const byPath = new Map(tree.map((e) => [e.path, e]));

      // Entries carry-forward via the diff (above), but excluded counts need the
      // FULL tree — the assets they count are never mirrored, so they can only
      // be derived from git's own listing at the new head.
      const { excludedCounts } = classifyTree(tree.map((e) => e.path));

      const blobs: BlobInput[] = [];
      const entries: EntryInput[] = [];

      for (const entry of classified) {
        const treeEntry = byPath.get(entry.path);
        if (!treeEntry) continue; // defensive: should always resolve post-diff
        entries.push({
          path: entry.path,
          blobSha: treeEntry.sha,
          kind: entry.kind,
          scopePath: entry.scopePath,
        });

        if (!changedPaths.has(entry.path)) continue;

        // Size-known-upfront skip — see the identical check in ensureSnapshotAt.
        if (treeEntry.size > 0 && treeEntry.size > OVERSIZE_BYTES) continue;

        const file = await git.getFileContent(i.repo, entry.path, i.afterSha);
        if (file.size <= OVERSIZE_BYTES) {
          blobs.push({ blobSha: treeEntry.sha, content: file.content, size: file.size });
        }
      }

      const { snapshotId } = await db.createSnapshot({
        appId: i.appId,
        tenantId: i.tenantId,
        branch: i.branch,
        commitSha: i.afterSha,
        classifierVersion: CLASSIFIER_VERSION,
        blobs,
        entries,
        excludedCounts,
      });

      return { kind: 'snapshotted', commitSha: i.afterSha, snapshotId };
    } catch (err) {
      // The push sha is always known from the webhook payload, so a push
      // failure is always "after HEAD resolution" (sha set).
      return {
        kind: 'failed',
        commitSha: i.afterSha,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Map a completed attempt to its ledger row, or null when there is nothing
   * to record: a wrong-branch push (`ignored` with no resolved commit) is not
   * an attempt on this app's tracked context.
   */
  function eventFor(
    trigger: SyncTrigger,
    ctx: { appId: string; tenantId: string; branch: string; commitMessage: string | null },
    outcome: SyncOutcome,
    startMs: number,
  ): SyncEventInput | null {
    const durationMs = Date.now() - startMs;
    if (outcome.kind === 'failed') {
      return {
        ...ctx,
        trigger,
        status: 'failed',
        commitSha: outcome.commitSha ?? null,
        error: outcome.error ?? 'unknown error',
        durationMs,
        snapshotId: null,
      };
    }
    if (outcome.kind === 'ignored' && outcome.commitSha === undefined) {
      return null;
    }
    return {
      ...ctx,
      trigger,
      status: 'synced',
      commitSha: outcome.commitSha ?? null,
      error: null,
      durationMs,
      snapshotId: outcome.snapshotId ?? null,
    };
  }

  async function recordEvent(
    trigger: SyncTrigger,
    ctx: { appId: string; tenantId: string; branch: string; commitMessage: string | null },
    outcome: SyncOutcome,
    startMs: number,
  ): Promise<void> {
    const event = eventFor(trigger, ctx, outcome, startMs);
    if (!event) return;
    try {
      await db.recordSyncEvent(event);
    } catch {
      // The event ledger is a best-effort audit log; a failed insert must
      // never turn a successful (or failed) sync into a thrown error.
    }
  }

  async function initialSync(i: InitialSyncInput): Promise<SyncOutcome> {
    const start = Date.now();
    const outcome = await ensureSnapshotAt({
      appId: i.appId,
      tenantId: i.tenantId,
      repo: i.repo,
      ref: { branch: i.branch },
    });
    // Link resolves HEAD but never fetches the commit message — leave it NULL.
    await recordEvent(
      'link',
      { appId: i.appId, tenantId: i.tenantId, branch: i.branch, commitMessage: null },
      outcome,
      start,
    );
    return outcome;
  }

  async function resync(i: ResyncInput): Promise<SyncOutcome> {
    const start = Date.now();
    const outcome = await ensureSnapshotAt({
      appId: i.appId,
      tenantId: i.tenantId,
      repo: i.repo,
      ref: { branch: i.branch },
    });
    await recordEvent(
      'resync',
      { appId: i.appId, tenantId: i.tenantId, branch: i.branch, commitMessage: null },
      outcome,
      start,
    );
    return outcome;
  }

  async function syncOnPush(i: SyncOnPushInput): Promise<SyncOutcome> {
    const start = Date.now();
    const outcome = await computePushOutcome(i);
    await recordEvent(
      'push',
      {
        appId: i.appId,
        tenantId: i.tenantId,
        branch: i.branch,
        commitMessage: i.commitMessage,
      },
      outcome,
      start,
    );
    return outcome;
  }

  return { syncOnPush, initialSync, resync, ensureSnapshotAt };
}
