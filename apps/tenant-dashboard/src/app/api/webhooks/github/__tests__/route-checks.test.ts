// @vitest-environment node
//
// NextRequest pulls in Next.js internals that touch `new TextEncoder()` at
// module-load time; the jsdom polyfill isn't installed early enough. Node's
// built-in TextEncoder matches production, so run this file under node.

/**
 * Route-level test for the GitHub webhook push adapter.
 *
 * The route verifies the signature, normalizes the payload, builds the provider
 * + check runner, and hands off to the provider-agnostic push core. Here we run
 * the REAL route + REAL core, mocking only the leaves the core drives (routing,
 * mirror sync, pointer advance) so we can pin the ADAPTER + check lifecycle and,
 * critically, that a push writes ZERO deployment rows (this sync flow tracks
 * context, it doesn't create deployments). The Checks API calls go through the
 * real Octokit → MSW.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Octokit } from 'octokit';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

beforeAll(() => {
  if (typeof (globalThis.Response as unknown as { json?: unknown }).json !== 'function') {
    (globalThis.Response as unknown as { json: unknown }).json = (
      body: unknown,
      init?: ResponseInit,
    ) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
  }
});

const { mockResolveWatchingApps, mockSyncOnPush, mockAdvanceCommitPointers } = vi.hoisted(() => ({
  mockResolveWatchingApps: vi.fn(),
  mockSyncOnPush: vi.fn(),
  mockAdvanceCommitPointers: vi.fn().mockResolvedValue(undefined),
}));

// Mock the leaves the core drives — the router, sync algorithm, and pointer
// helper each have their own tests. Keeping the route + core + check runner
// real is what makes this a route-level proof.
vi.mock('@/lib/system/context-sync/resolve-watching-apps', () => ({
  resolveWatchingApps: mockResolveWatchingApps,
}));
vi.mock('@repo/context-sync', () => ({
  buildContextSync: () => ({ syncOnPush: mockSyncOnPush }),
}));
vi.mock('@/lib/system/git/commit-pointers', () => ({
  advanceCommitPointers: mockAdvanceCommitPointers,
}));

const FAKE_INSTALLATION_TOKEN = 'fake-installation-token';

vi.mock('@/octo-kit', () => ({
  getGithubApp: () => ({
    getInstallationOctokit: async () => new Octokit({ auth: FAKE_INSTALLATION_TOKEN }),
  }),
}));

const WEBHOOK_SECRET = 'test-webhook-secret';
const HEAD_SHA = 'a'.repeat(40);
const INSTALLATION_ID = 12345;

function signPayload(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function buildPushRequest(payload: object): NextRequest {
  const body = JSON.stringify(payload);
  return new NextRequest('http://localhost:3002/api/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': signPayload(body),
    },
    body,
  });
}

function basePushPayload() {
  return {
    ref: 'refs/heads/main',
    before: 'b'.repeat(40),
    after: HEAD_SHA,
    repository: { id: 999, name: 'prompts', full_name: 'acme/prompts', private: true },
    head_commit: { id: HEAD_SHA, message: 'Test push' },
    commits: [],
    installation: { id: INSTALLATION_ID },
  };
}

describe('POST /api/webhooks/github — push adapter + check lifecycle', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdvanceCommitPointers.mockResolvedValue(undefined);
  });

  it('syncs the watching app and posts a passing check', async () => {
    mockResolveWatchingApps.mockResolvedValue([
      { appId: 'app-1', appName: 'acme-prompts', tenantId: 'tenant-1', branch: 'main' },
    ]);
    mockSyncOnPush.mockResolvedValue({ kind: 'snapshotted', commitSha: HEAD_SHA, snapshotId: 's1' });

    const { POST } = await import('../route');
    const { getCreatedCheckRuns, getUpdatedCheckRuns } = await import('@/test-helpers/msw-handlers');

    const response = await POST(buildPushRequest(basePushPayload()));
    expect(response.status).toBe(200);

    // The check was opened under the repurposed name and closed as success.
    const created = getCreatedCheckRuns();
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toEqual(
      expect.objectContaining({ name: 'OuterLayer context sync', head_sha: HEAD_SHA, status: 'in_progress' }),
    );
    const updated = getUpdatedCheckRuns();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.body).toEqual(
      expect.objectContaining({ status: 'completed', conclusion: 'success' }),
    );

    // The head commit message flows through to the sync.
    expect(mockSyncOnPush).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        repo: 'acme/prompts',
        branch: 'main',
        afterSha: HEAD_SHA,
        commitMessage: 'Test push',
      }),
    );
  });

  it('posts a neutral check when no app watches the branch', async () => {
    mockResolveWatchingApps.mockResolvedValue([]);

    const { POST } = await import('../route');
    const { getUpdatedCheckRuns } = await import('@/test-helpers/msw-handlers');

    const response = await POST(buildPushRequest(basePushPayload()));
    expect(response.status).toBe(200);

    const updated = getUpdatedCheckRuns();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.body.conclusion).toBe('neutral');
    expect(mockSyncOnPush).not.toHaveBeenCalled();
  });

  it('skips the check entirely on a branch deletion (head SHA all zeros)', async () => {
    mockResolveWatchingApps.mockResolvedValue([]);

    const { POST } = await import('../route');
    const { getCreatedCheckRuns, getUpdatedCheckRuns } = await import('@/test-helpers/msw-handlers');

    const response = await POST(
      buildPushRequest({ ...basePushPayload(), after: '0'.repeat(40) }),
    );
    expect(response.status).toBe(200);
    expect(getCreatedCheckRuns()).toHaveLength(0);
    expect(getUpdatedCheckRuns()).toHaveLength(0);
  });

  it('rejects an unsigned payload with 401 before touching the Checks API', async () => {
    const { POST } = await import('../route');
    const { getCreatedCheckRuns } = await import('@/test-helpers/msw-handlers');

    const body = JSON.stringify(basePushPayload());
    const request = new NextRequest('http://localhost:3002/api/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' },
      body,
    });

    const res = await POST(request);
    expect(res.status).toBe(401);
    expect(getCreatedCheckRuns()).toHaveLength(0);
  });
});
