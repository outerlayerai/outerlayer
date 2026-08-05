/**
 * Unit tests for the sync algorithm against fake ports — no Supabase, no real
 * git calls. Exact-shape assertions per the repo test bar: every assertion
 * pins a concrete value or a positional array, never a bare
 * `toBeDefined`/`toHaveBeenCalled`.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifyTree } from '@repo/context-core';
import { createContextSync } from './sync';
import type {
  ContextHeadRecord,
  ContextMirrorPort,
  FileContent,
  FileDiff,
  GitPort,
} from './types';

function fakeDb(overrides: Partial<ContextMirrorPort> = {}): ContextMirrorPort {
  return {
    loadHead: vi.fn(async () => null),
    getSnapshotPaths: vi.fn(async () => []),
    hasBlob: vi.fn(async () => false),
    createSnapshot: vi.fn(async () => ({ snapshotId: 'new-snapshot' })),
    advanceHead: vi.fn(async () => undefined),
    recordSyncEvent: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeGit(overrides: Partial<GitPort> = {}): GitPort {
  return {
    getLatestCommitSha: vi.fn(async () => 'resolved-sha'),
    getFileContent: vi.fn(async (_repo, path, _ref): Promise<FileContent> => ({
      path,
      content: `content of ${path}`,
      sha: `sha-of-${path}`,
      size: 10,
      encoding: 'utf-8',
    })),
    compareCommits: vi.fn(async () => []),
    listTree: vi.fn(async () => []),
    ...overrides,
  };
}

const HEAD: ContextHeadRecord = { branch: 'main', commitSha: 'sha-before', snapshotId: 'snap-1' };

describe('syncOnPush', () => {
  it('advances the head without a new snapshot when the push touches no context paths', async () => {
    const db = fakeDb({
      loadHead: vi.fn(async () => HEAD),
    });
    const git = fakeGit({
      compareCommits: vi.fn(
        async (): Promise<FileDiff[]> => [
          { path: 'src/index.ts', status: 'modified', additions: 1, deletions: 1, sha: 'sha-x' },
        ]
      ),
    });
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'advanced-only', commitSha: 'sha-after', snapshotId: 'snap-1' });
    expect(db.advanceHead).toHaveBeenCalledWith({
      appId: 'app-1',
      tenantId: 'tenant-1',
      branch: 'main',
      commitSha: 'sha-after',
      snapshotId: 'snap-1',
    });
    expect(db.createSnapshot).not.toHaveBeenCalled();
  });

  it('maps added/modified/removed/renamed changes into a positional entries array, carrying forward unchanged paths without fetching them', async () => {
    const db = fakeDb({
      loadHead: vi.fn(async () => HEAD),
      getSnapshotPaths: vi.fn(async () => [
        '.outerlayer/a.md',
        '.outerlayer/b.md',
        '.outerlayer/old.md',
        '.outerlayer/d.md',
      ]),
    });

    const git = fakeGit({
      compareCommits: vi.fn(
        async (): Promise<FileDiff[]> => [
          { path: '.outerlayer/c.md', status: 'added', additions: 1, deletions: 0, sha: 'x' },
          { path: '.outerlayer/b.md', status: 'modified', additions: 1, deletions: 1, sha: 'x' },
          { path: '.outerlayer/a.md', status: 'removed', additions: 0, deletions: 5, sha: 'x' },
          {
            path: '.outerlayer/new.md',
            previousPath: '.outerlayer/old.md',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            sha: 'x',
          },
        ]
      ),
      listTree: vi.fn(async () => [
        { path: '.outerlayer/b.md', sha: 'sha-b2', size: 10 },
        { path: '.outerlayer/d.md', sha: 'sha-d', size: 10 },
        { path: '.outerlayer/c.md', sha: 'sha-c', size: 10 },
        { path: '.outerlayer/new.md', sha: 'sha-new', size: 10 },
      ]),
      getFileContent: vi.fn(async (_repo, path): Promise<FileContent> => ({
        path,
        content: `content of ${path}`,
        sha: `sha-of-${path}`,
        size: 10,
        encoding: 'utf-8',
      })),
    });

    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'snapshotted', commitSha: 'sha-after', snapshotId: 'new-snapshot' });

    expect(db.createSnapshot).toHaveBeenCalledTimes(1);
    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];

    // Positional: nextPaths order from applySnapshotChanges' Set semantics —
    // survivors keep their original slot, renames land at the end.
    expect(call.entries).toEqual([
      { path: '.outerlayer/b.md', blobSha: 'sha-b2', kind: 'reference', scopePath: '' },
      { path: '.outerlayer/d.md', blobSha: 'sha-d', kind: 'reference', scopePath: '' },
      { path: '.outerlayer/c.md', blobSha: 'sha-c', kind: 'reference', scopePath: '' },
      { path: '.outerlayer/new.md', blobSha: 'sha-new', kind: 'reference', scopePath: '' },
    ]);

    // Carried-forward d.md is never fetched; only the 3 changed paths are.
    expect(git.getFileContent).toHaveBeenCalledTimes(3);
    expect(git.getFileContent).not.toHaveBeenCalledWith('owner/repo', '.outerlayer/d.md', 'sha-after');

    expect(call.blobs.map((b: { blobSha: string }) => b.blobSha).sort()).toEqual(
      ['sha-b2', 'sha-c', 'sha-new'].sort()
    );
  });

  it('applies the size guard per changed path: skips fetch for a known-oversize file, includes the exact-boundary file, and fetches-but-discards an unknown-size file that turns out oversize', async () => {
    const BOUNDARY_BYTES = 1_048_576; // OVERSIZE_BYTES exactly
    const db = fakeDb({
      loadHead: vi.fn(async () => HEAD),
      getSnapshotPaths: vi.fn(async () => []),
    });
    const git = fakeGit({
      compareCommits: vi.fn(
        async (): Promise<FileDiff[]> => [
          { path: '.outerlayer/known-big.md', status: 'added', additions: 1, deletions: 0, sha: 'x' },
          { path: '.outerlayer/boundary.md', status: 'added', additions: 1, deletions: 0, sha: 'x' },
          { path: '.outerlayer/unknown-big.md', status: 'added', additions: 1, deletions: 0, sha: 'x' },
        ]
      ),
      listTree: vi.fn(async () => [
        { path: '.outerlayer/known-big.md', sha: 'sha-known-big', size: 2_000_000 }, // known upfront, > boundary
        { path: '.outerlayer/boundary.md', sha: 'sha-boundary', size: BOUNDARY_BYTES }, // exactly at boundary
        { path: '.outerlayer/unknown-big.md', sha: 'sha-unknown-big', size: 0 }, // "unavailable" upfront
      ]),
      getFileContent: vi.fn(async (_repo, path): Promise<FileContent> => ({
        path,
        content: `content of ${path}`,
        sha: `sha-of-${path}`,
        size: path.includes('unknown-big') ? 2_000_000 : BOUNDARY_BYTES,
        encoding: 'utf-8',
      })),
    });
    const sync = createContextSync({ db, git });

    await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    // known-oversize is skipped BEFORE fetch; the other two are fetched.
    expect(git.getFileContent).toHaveBeenCalledTimes(2);
    expect(git.getFileContent).not.toHaveBeenCalledWith(
      'owner/repo',
      '.outerlayer/known-big.md',
      'sha-after',
    );

    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.entries).toEqual([
      { path: '.outerlayer/known-big.md', blobSha: 'sha-known-big', kind: 'reference', scopePath: '' },
      { path: '.outerlayer/boundary.md', blobSha: 'sha-boundary', kind: 'reference', scopePath: '' },
      { path: '.outerlayer/unknown-big.md', blobSha: 'sha-unknown-big', kind: 'reference', scopePath: '' },
    ]);
    // Only the exact-boundary file (not strictly over) makes it into blobs.
    expect(call.blobs).toEqual([
      { blobSha: 'sha-boundary', content: 'content of .outerlayer/boundary.md', size: BOUNDARY_BYTES },
    ]);
  });

  it('silently drops a changed-path entry missing from the fresh git tree at afterSha (local diff bookkeeping and git state may diverge)', async () => {
    const db = fakeDb({
      loadHead: vi.fn(async () => HEAD),
      getSnapshotPaths: vi.fn(async () => []),
    });
    const git = fakeGit({
      compareCommits: vi.fn(
        async (): Promise<FileDiff[]> => [
          { path: '.outerlayer/ghost.md', status: 'added', additions: 1, deletions: 0, sha: 'x' },
        ]
      ),
      // The fresh tree at afterSha does NOT contain the path the diff says was
      // added — e.g. a race between the diff API and the tree listing.
      listTree: vi.fn(async () => []),
    });
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'snapshotted', commitSha: 'sha-after', snapshotId: 'new-snapshot' });
    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.entries).toEqual([]);
    expect(call.blobs).toEqual([]);
    expect(git.getFileContent).not.toHaveBeenCalled();
  });

  it('self-heals via a full resync when the reported before-sha does not match the stored head', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) });
    const git = fakeGit({
      listTree: vi.fn(async () => [{ path: '.outerlayer/AGENTS.md', sha: 'sha-agents', size: 10 }]),
    });
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-mismatched', // not HEAD.commitSha
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'resynced', commitSha: 'resolved-sha', snapshotId: 'new-snapshot' });
    expect(git.compareCommits).not.toHaveBeenCalled();
    expect(git.listTree).toHaveBeenCalledWith('owner/repo', 'resolved-sha');
    // The self-heal resolves the TRACKED branch, not a bare/empty ref.
    expect(git.getLatestCommitSha).toHaveBeenCalledWith('owner/repo', 'main');
  });

  it('is a no-op for a duplicate/replayed webhook whose afterSha already matches the head', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) });
    const git = fakeGit();
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-before', // == HEAD.commitSha
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'ignored', commitSha: 'sha-before', snapshotId: 'snap-1' });
    expect(git.compareCommits).not.toHaveBeenCalled();
    expect(db.advanceHead).not.toHaveBeenCalled();
    expect(db.createSnapshot).not.toHaveBeenCalled();
  });

  it('ignores a push to a branch other than the one context is tracking', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) }); // HEAD.branch === 'main'
    const git = fakeGit();
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'feature/other',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'ignored' });
    expect(git.compareCommits).not.toHaveBeenCalled();
    expect(db.createSnapshot).not.toHaveBeenCalled();
    expect(db.advanceHead).not.toHaveBeenCalled();
  });

  it('returns failed and never calls createSnapshot when a provider call throws mid-diff', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) });
    const git = fakeGit({
      compareCommits: vi.fn(async () => {
        throw new Error('provider outage');
      }),
    });
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    // A push failure always carries the payload's afterSha (failure after the
    // sha is known).
    expect(outcome).toEqual({ kind: 'failed', commitSha: 'sha-after', error: 'provider outage' });
    expect(db.createSnapshot).not.toHaveBeenCalled();
    expect(db.advanceHead).not.toHaveBeenCalled();
  });

  it('bootstraps via a full resync when no head exists yet', async () => {
    const db = fakeDb(); // loadHead → null
    const git = fakeGit({
      listTree: vi.fn(async () => [{ path: '.outerlayer/AGENTS.md', sha: 'sha-agents', size: 10 }]),
    });
    const sync = createContextSync({ db, git });

    const outcome = await sync.syncOnPush({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(outcome).toEqual({ kind: 'resynced', commitSha: 'resolved-sha', snapshotId: 'new-snapshot' });
    expect(git.getLatestCommitSha).toHaveBeenCalledWith('owner/repo', 'main');
  });
});

describe('ensureSnapshotAt / resync', () => {
  it('writes an entry for an oversize file but skips its content fetch entirely when size is known upfront', async () => {
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () => [
        { path: '.outerlayer/big.md', sha: 'sha-big', size: 2_000_000 }, // > 1 MiB
      ]),
    });
    const sync = createContextSync({ db, git });

    const outcome = await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    expect(outcome).toEqual({ kind: 'resynced', commitSha: 'resolved-sha', snapshotId: 'new-snapshot' });
    expect(git.getFileContent).not.toHaveBeenCalled();

    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.entries).toEqual([
      { path: '.outerlayer/big.md', blobSha: 'sha-big', kind: 'reference', scopePath: '' },
    ]);
    expect(call.blobs).toEqual([]);
  });

  it('skips already-mirrored blobs via hasBlob without fetching content (resync idempotence)', async () => {
    const db = fakeDb({ hasBlob: vi.fn(async () => true) });
    const git = fakeGit({
      listTree: vi.fn(async () => [{ path: '.outerlayer/AGENTS.md', sha: 'sha-agents', size: 10 }]),
    });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    expect(git.getFileContent).not.toHaveBeenCalled();
    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.blobs).toEqual([]);
    expect(call.entries).toEqual([
      { path: '.outerlayer/AGENTS.md', blobSha: 'sha-agents', kind: 'instructions', scopePath: '' },
    ]);
  });

  it('fetches and mirrors content for a normal-size unmirrored blob', async () => {
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () => [
        { path: '.outerlayer/small.md', sha: 'sha-small', size: 500 },
      ]),
      getFileContent: vi.fn(async (_repo, path): Promise<FileContent> => ({
        path,
        content: 'small content',
        sha: 'sha-small',
        size: 500,
        encoding: 'utf-8',
      })),
    });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    expect(git.getFileContent).toHaveBeenCalledWith(
      'owner/repo',
      '.outerlayer/small.md',
      'resolved-sha',
    );
    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.blobs).toEqual([{ blobSha: 'sha-small', content: 'small content', size: 500 }]);
  });

  it('does not trip the upfront oversize skip at exactly the 1 MiB boundary (the guard is strictly greater-than)', async () => {
    const BOUNDARY_BYTES = 1_048_576; // OVERSIZE_BYTES exactly
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () => [
        { path: '.outerlayer/boundary.md', sha: 'sha-boundary', size: BOUNDARY_BYTES },
      ]),
      getFileContent: vi.fn(async (_repo, path): Promise<FileContent> => ({
        path,
        content: 'boundary content',
        sha: 'sha-boundary',
        size: BOUNDARY_BYTES,
        encoding: 'utf-8',
      })),
    });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    expect(git.getFileContent).toHaveBeenCalledTimes(1);
    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.blobs).toEqual([
      { blobSha: 'sha-boundary', content: 'boundary content', size: BOUNDARY_BYTES },
    ]);
  });

  it('still fetches content when tree size is unreported (0) even if the fetched content turns out oversize', async () => {
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () => [
        { path: '.outerlayer/unknown-size.md', sha: 'sha-unknown', size: 0 },
      ]),
      getFileContent: vi.fn(async (_repo, path): Promise<FileContent> => ({
        path,
        content: 'huge content',
        sha: 'sha-unknown',
        size: 2_000_000, // turns out to exceed OVERSIZE_BYTES only once fetched
        encoding: 'utf-8',
      })),
    });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    // size=0 never satisfies the "known upfront" guard, so the fetch still happens...
    expect(git.getFileContent).toHaveBeenCalledWith(
      'owner/repo',
      '.outerlayer/unknown-size.md',
      'resolved-sha',
    );
    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // ...but the oversize result is discarded from blobs while the entry survives.
    expect(call.entries).toEqual([
      { path: '.outerlayer/unknown-size.md', blobSha: 'sha-unknown', kind: 'reference', scopePath: '' },
    ]);
    expect(call.blobs).toEqual([]);
  });

  it('passes excludedCounts (from the full git tree) through to createSnapshot for the tree annotation', async () => {
    // A skill dir with one content file (SKILL.md) and one non-content asset
    // that is NOT mirrored — classifyTree counts the asset as excluded.
    const fullTreePaths = [
      '.outerlayer/skills/deploy/SKILL.md',
      '.outerlayer/skills/deploy/run.py',
    ];
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () =>
        fullTreePaths.map((path) => ({ path, sha: `sha-${path}`, size: 10 })),
      ),
    });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    const call = (db.createSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const expected = classifyTree(fullTreePaths).excludedCounts;
    // The wiring passes the classifier's full-tree excluded counts verbatim,
    // and this fixture actually produces one (the asset), so it's non-trivial.
    expect(expected).toEqual([{ scopePath: '', skillName: 'deploy', count: 1 }]);
    expect(call.excludedCounts).toEqual(expected);
  });

  it('passes the connected branch through to createSnapshot so the atomic write advances context_head', async () => {
    const db = fakeDb();
    const git = fakeGit({ listTree: vi.fn(async () => []) });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { branch: 'main' },
    });

    expect(db.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'main', commitSha: 'resolved-sha' })
    );
  });

  it('does not advance any head when materializing a snapshot for a bare commit sha', async () => {
    const db = fakeDb();
    const git = fakeGit({ listTree: vi.fn(async () => []) });
    const sync = createContextSync({ db, git });

    await sync.ensureSnapshotAt({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      ref: { commitSha: 'sha-pinned' },
    });

    expect(git.getLatestCommitSha).not.toHaveBeenCalled();
    expect(db.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ branch: null, commitSha: 'sha-pinned' })
    );
  });
});

describe('initialSync', () => {
  it('delegates to ensureSnapshotAt for the given branch', async () => {
    const db = fakeDb();
    const git = fakeGit({ listTree: vi.fn(async () => []) });
    const sync = createContextSync({ db, git });

    const outcome = await sync.initialSync({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'owner/repo',
      branch: 'main',
    });

    expect(outcome).toEqual({ kind: 'resynced', commitSha: 'resolved-sha', snapshotId: 'new-snapshot' });
    expect(git.getLatestCommitSha).toHaveBeenCalledWith('owner/repo', 'main');
  });
});

// ---------------------------------------------------------------------------
// Self-reporting: exactly one context_sync_event per attempt, via the db port.
// ---------------------------------------------------------------------------

describe('self-reporting (context_sync_event)', () => {
  const CTX = { appId: 'app-1', tenantId: 'tenant-1', repo: 'owner/repo' };

  function recordedEvents(db: ContextMirrorPort) {
    return (db.recordSyncEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  }

  it('(a) records a synced link event with the newly created snapshot', async () => {
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () => [{ path: '.outerlayer/AGENTS.md', sha: 'sha-agents', size: 10 }]),
    });
    const sync = createContextSync({ db, git });

    await sync.initialSync({ ...CTX, branch: 'main' });

    const events = recordedEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      appId: 'app-1',
      tenantId: 'tenant-1',
      branch: 'main',
      trigger: 'link',
      status: 'synced',
      commitSha: 'resolved-sha',
      commitMessage: null,
      snapshotId: 'new-snapshot',
      error: null,
      durationMs: expect.any(Number),
    });
  });

  it('computes durationMs as elapsed time (completion Date.now() minus the recorded start), not the reverse', async () => {
    const db = fakeDb();
    const git = fakeGit({
      listTree: vi.fn(async () => []),
    });
    const sync = createContextSync({ db, git });

    const start = 1_000_000;
    const end = 1_000_250;
    const dateSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(start) // captured at the top of initialSync
      .mockReturnValueOnce(end); // captured when eventFor computes durationMs

    await sync.initialSync({ ...CTX, branch: 'main' });

    const events = recordedEvents(db);
    expect(events[0]!.durationMs).toBe(250);

    dateSpy.mockRestore();
  });

  it('(b) records a synced push event that points at the carried-forward head snapshot when the tree did not change', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) });
    const git = fakeGit({
      compareCommits: vi.fn(
        async (): Promise<FileDiff[]> => [
          { path: 'src/index.ts', status: 'modified', additions: 1, deletions: 1, sha: 'sha-x' },
        ]
      ),
    });
    const sync = createContextSync({ db, git });

    await sync.syncOnPush({
      ...CTX,
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: 'chore: tweak src (no context change)',
    });

    const events = recordedEvents(db);
    expect(events).toHaveLength(1);
    // The push event carries the payload's head-commit message verbatim.
    expect(events[0]).toEqual({
      appId: 'app-1',
      tenantId: 'tenant-1',
      branch: 'main',
      trigger: 'push',
      status: 'synced',
      commitSha: 'sha-after',
      commitMessage: 'chore: tweak src (no context change)',
      snapshotId: 'snap-1',
      error: null,
      durationMs: expect.any(Number),
    });
  });

  it('(c) records a failed resync event WITH the resolved sha when the failure is after HEAD resolution', async () => {
    const db = fakeDb();
    const git = fakeGit({
      getLatestCommitSha: vi.fn(async () => 'resolved-sha'),
      listTree: vi.fn(async () => {
        throw new Error('tree listing failed');
      }),
    });
    const sync = createContextSync({ db, git });

    await sync.resync({ ...CTX, branch: 'main' });

    // resync() passes the caller's branch through to ensureSnapshotAt's ref,
    // not a bare/empty ref.
    expect(git.getLatestCommitSha).toHaveBeenCalledWith('owner/repo', 'main');

    const events = recordedEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      appId: 'app-1',
      tenantId: 'tenant-1',
      branch: 'main',
      trigger: 'resync',
      status: 'failed',
      commitSha: 'resolved-sha',
      commitMessage: null,
      snapshotId: null,
      error: 'tree listing failed',
      durationMs: expect.any(Number),
    });
  });

  it('(d) records a failed resync event with a NULL sha when the failure is before HEAD resolution', async () => {
    const db = fakeDb();
    const git = fakeGit({
      getLatestCommitSha: vi.fn(async () => null), // ref never resolves
    });
    const sync = createContextSync({ db, git });

    await sync.resync({ ...CTX, branch: 'main' });

    const events = recordedEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      appId: 'app-1',
      tenantId: 'tenant-1',
      branch: 'main',
      trigger: 'resync',
      status: 'failed',
      commitSha: null,
      commitMessage: null,
      snapshotId: null,
      error: 'could not resolve ref for owner/repo',
      durationMs: expect.any(Number),
    });
  });

  it('records NO event for a wrong-branch push (not an attempt on this app\'s context)', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) }); // tracking 'main'
    const git = fakeGit();
    const sync = createContextSync({ db, git });

    await sync.syncOnPush({
      ...CTX,
      branch: 'feature/other',
      beforeSha: 'sha-before',
      afterSha: 'sha-after',
      commitMessage: null,
    });

    expect(db.recordSyncEvent).not.toHaveBeenCalled();
  });

  it('records a synced push event on a duplicate/replayed webhook (redelivery = a second attempt row)', async () => {
    const db = fakeDb({ loadHead: vi.fn(async () => HEAD) });
    const git = fakeGit();
    const sync = createContextSync({ db, git });

    await sync.syncOnPush({
      ...CTX,
      branch: 'main',
      beforeSha: 'sha-before',
      afterSha: 'sha-before', // == HEAD.commitSha (duplicate)
      commitMessage: null,
    });

    const events = recordedEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trigger: 'push',
      status: 'synced',
      commitSha: 'sha-before',
      snapshotId: 'snap-1',
    });
  });
});
