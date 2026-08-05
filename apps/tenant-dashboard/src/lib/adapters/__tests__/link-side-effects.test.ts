/**
 * The three repo-link side-effect adapters, each non-fatal by contract: a
 * failure in any of them must never fail (or reject out of) the repo-link
 * flow that triggers it.
 */

const mockInitialSync = vi.fn();
const mockBuildContextSync = vi.fn((..._args: unknown[]) => ({ initialSync: mockInitialSync }));
vi.mock('@/lib/system/context-sync', () => ({
  buildContextSync: (...args: unknown[]) => mockBuildContextSync(...args),
  createSupabaseContextMirrorPort: vi.fn(() => ({ __mirrorPort: true })),
}));

const mockAdvanceCommitPointers = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/system/git/commit-pointers', () => ({
  advanceCommitPointers: (...args: unknown[]) => mockAdvanceCommitPointers(...args),
}));

const mockBackfillPullRequests = vi.fn();
vi.mock('@/lib/system/pr-tracking/backfill', () => ({
  backfillPullRequests: (...args: unknown[]) => mockBackfillPullRequests(...args),
}));

const mockEnrichPullRequests = vi.fn();
vi.mock('@/lib/system/pr-tracking/enrichment-backfill', () => ({
  ENRICHMENT_LINK_LIMIT: 200,
  enrichPullRequestsForConnection: (...args: unknown[]) => mockEnrichPullRequests(...args),
}));

const mockLoggerError = vi.fn();
vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: { withAppId: () => ({ error: mockLoggerError }) },
}));

vi.mock('@/lib/observability/error-reporting/sentry', () => ({ setTag: vi.fn() }));

import {
  runContextMirrorInitialSync,
  runPullRequestBackfill,
  runPullRequestEnrichment,
} from '../link-side-effects';

const gitProvider = { type: 'github' } as unknown as import('@/lib/system/git').GitProvider;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runContextMirrorInitialSync', () => {
  it('advances the commit pointers to the SHA the mirror materialized on a synced outcome', async () => {
    mockInitialSync.mockResolvedValue({ kind: 'snapshotted', commitSha: 'abc123', snapshotId: 'snap-1' });

    await runContextMirrorInitialSync({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'acme/triage',
      branch: 'main',
      gitProvider,
    });

    expect(mockInitialSync).toHaveBeenCalledWith({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'acme/triage',
      branch: 'main',
    });
    expect(mockAdvanceCommitPointers).toHaveBeenCalledWith(
      expect.anything(),
      { appId: 'app-1', commitSha: 'abc123' },
    );
  });

  it('does not advance pointers and logs (never throws) when the sync reports a failed outcome', async () => {
    mockInitialSync.mockResolvedValue({ kind: 'failed', error: 'clone timeout' });

    await expect(
      runContextMirrorInitialSync({
        appId: 'app-1',
        tenantId: 'tenant-1',
        repo: 'acme/triage',
        branch: 'main',
        gitProvider,
      }),
    ).resolves.toBeUndefined();

    expect(mockAdvanceCommitPointers).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('clone timeout') }),
    );
  });

  it('does not advance pointers when the sync resolves without a commit SHA', async () => {
    mockInitialSync.mockResolvedValue({ kind: 'noop' });

    await runContextMirrorInitialSync({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repo: 'acme/triage',
      branch: 'main',
      gitProvider,
    });

    expect(mockAdvanceCommitPointers).not.toHaveBeenCalled();
  });

  it('swallows a thrown error from the sync pipeline rather than rejecting', async () => {
    mockInitialSync.mockRejectedValue(new Error('network down'));

    await expect(
      runContextMirrorInitialSync({
        appId: 'app-1',
        tenantId: 'tenant-1',
        repo: 'acme/triage',
        branch: 'main',
        gitProvider,
      }),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('network down') }),
    );
  });
});

describe('runPullRequestBackfill', () => {
  it('runs the backfill scoped to the app/tenant/repo/provider', async () => {
    mockBackfillPullRequests.mockResolvedValue({ synced: 3 });

    await runPullRequestBackfill({
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/triage',
      provider: gitProvider,
    });

    expect(mockBackfillPullRequests).toHaveBeenCalledWith({
      supabase: expect.anything(),
      provider: gitProvider,
      appId: 'app-1',
      tenantId: 'tenant-1',
      repository: 'acme/triage',
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('logs (never throws) on a backfill error result', async () => {
    mockBackfillPullRequests.mockResolvedValue({ error: 'rate limited' });

    await expect(
      runPullRequestBackfill({ appId: 'app-1', tenantId: 'tenant-1', repository: 'acme/triage', provider: gitProvider }),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('rate limited') }),
    );
  });
});

describe('runPullRequestEnrichment', () => {
  it('enriches with the app/repo/provider and the fixed link limit', async () => {
    mockEnrichPullRequests.mockResolvedValue({ examined: 5, diffFilled: 5, ciFilled: 5, errors: [] });

    await runPullRequestEnrichment({ appId: 'app-1', repository: 'acme/triage', provider: gitProvider });

    expect(mockEnrichPullRequests).toHaveBeenCalledWith({
      supabase: expect.anything(),
      provider: gitProvider,
      appId: 'app-1',
      repository: 'acme/triage',
      limit: 200,
    });
  });

  it('logs each per-item error the enrichment reports', async () => {
    mockEnrichPullRequests.mockResolvedValue({ examined: 2, diffFilled: 1, ciFilled: 0, errors: ['pr-1 timeout'] });

    await runPullRequestEnrichment({ appId: 'app-1', repository: 'acme/triage', provider: gitProvider });

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('pr-1 timeout') }),
    );
  });

  it('a throwing enrichment call never rejects (best-effort contract)', async () => {
    mockEnrichPullRequests.mockRejectedValue(new Error('rate limited'));

    await expect(
      runPullRequestEnrichment({ appId: 'app-1', repository: 'acme/triage', provider: gitProvider }),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('rate limited') }),
    );
  });
});
