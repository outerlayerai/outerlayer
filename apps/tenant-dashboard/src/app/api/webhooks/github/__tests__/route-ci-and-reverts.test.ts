// @vitest-environment node

/**
 * Route-level tests for the GitHub webhook's CI-verdict dispatch
 * (workflow_run / check_run → recordFirstPassCiResult) and the push-time
 * revert scan. The pr-tracking services are true seams here — their write
 * protocols have their own MSW tests; this file pins the ADAPTER: which
 * events dispatch, how provider conclusions map to the success/failure
 * vocabulary, which ones are dropped, and what the push payload contributes.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
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

const { mockRecordFirstPassCiResult, mockScanPushForReverts, mockHandlePushEvent } = vi.hoisted(
  () => ({
    mockRecordFirstPassCiResult: vi.fn(),
    mockScanPushForReverts: vi.fn(),
    mockHandlePushEvent: vi.fn(),
  }),
);

vi.mock('@/lib/system/pr-tracking/ci-status', async (importOriginal) => ({
  // Keep the REAL conclusion mapping (pure) — only the recorder is a seam.
  ...(await importOriginal<typeof import('@/lib/system/pr-tracking/ci-status')>()),
  recordFirstPassCiResult: mockRecordFirstPassCiResult,
}));
vi.mock('@/lib/system/pr-tracking/push-revert-scan', () => ({
  scanPushForReverts: mockScanPushForReverts,
}));
vi.mock('@/lib/system/context-sync/handle-push-event', () => ({
  handlePushEvent: mockHandlePushEvent,
}));
vi.mock('@/octo-kit', () => ({
  getGithubApp: () => ({
    getInstallationOctokit: async () => ({}),
  }),
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/observability/server-logger', () => ({ serverLogger: logger }));

const WEBHOOK_SECRET = 'test-webhook-secret';
const HEAD_SHA = 'a'.repeat(40);

vi.mock('@/config-global.server', () => ({
  GITHUB_APP_ID: '123',
  GITHUB_APP_WEBHOOK_SECRET: 'test-webhook-secret',
}));

function signPayload(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function buildRequest(event: string, payload: object): NextRequest {
  const body = JSON.stringify(payload);
  return new NextRequest('http://localhost:3002/api/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': signPayload(body),
    },
    body,
  });
}

import { POST } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordFirstPassCiResult.mockResolvedValue(undefined);
  mockScanPushForReverts.mockResolvedValue(undefined);
  mockHandlePushEvent.mockResolvedValue(undefined);
});

describe('POST /api/webhooks/github — CI verdict events', () => {
  it('dispatches a completed workflow_run to the first-pass CI recorder', async () => {
    const res = await POST(
      buildRequest('workflow_run', {
        action: 'completed',
        workflow_run: { head_sha: HEAD_SHA, conclusion: 'success', updated_at: '2026-07-10T10:00:00Z' },
        repository: { full_name: 'acme/api' },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockRecordFirstPassCiResult).toHaveBeenCalledWith({
      repository: 'acme/api',
      headSha: HEAD_SHA,
      conclusion: 'success',
      completedAt: '2026-07-10T10:00:00Z',
    });
  });

  it('maps timed_out / startup_failure to failure (they say the code did not pass)', async () => {
    for (const conclusion of ['timed_out', 'startup_failure', 'failure']) {
      await POST(
        buildRequest('check_run', {
          action: 'completed',
          check_run: { head_sha: HEAD_SHA, conclusion, completed_at: '2026-07-10T10:00:00Z' },
          repository: { full_name: 'acme/api' },
        }),
      );
    }
    expect(mockRecordFirstPassCiResult).toHaveBeenCalledTimes(3);
    for (const call of mockRecordFirstPassCiResult.mock.calls) {
      expect(call[0].conclusion).toBe('failure');
    }
  });

  it('drops verdicts that say nothing about the code: cancelled, skipped, neutral, action_required', async () => {
    for (const conclusion of ['cancelled', 'skipped', 'neutral', 'action_required', 'stale', null]) {
      await POST(
        buildRequest('workflow_run', {
          action: 'completed',
          workflow_run: { head_sha: HEAD_SHA, conclusion },
          repository: { full_name: 'acme/api' },
        }),
      );
    }
    expect(mockRecordFirstPassCiResult).not.toHaveBeenCalled();
  });

  it('ignores non-completed actions (requested / in_progress carry no conclusion worth recording)', async () => {
    await POST(
      buildRequest('workflow_run', {
        action: 'requested',
        workflow_run: { head_sha: HEAD_SHA, conclusion: null },
        repository: { full_name: 'acme/api' },
      }),
    );
    expect(mockRecordFirstPassCiResult).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/github — push revert scan', () => {
  it('feeds the pushed branch and commit messages to the revert scanner', async () => {
    const res = await POST(
      buildRequest('push', {
        ref: 'refs/heads/main',
        before: 'b'.repeat(40),
        after: HEAD_SHA,
        repository: { full_name: 'acme/api' },
        installation: { id: 99 },
        head_commit: { id: HEAD_SHA, message: 'Revert "feat: widgets (#123)"', timestamp: '2026-07-10T10:00:00Z' },
        commits: [
          {
            id: HEAD_SHA,
            message: 'Revert "feat: widgets (#123)"',
            timestamp: '2026-07-10T10:00:00Z',
            author: { name: 'Dev', email: 'dev@acme.test' },
            added: [],
            modified: [],
            removed: [],
          },
        ],
        pusher: { name: 'dev' },
        sender: { login: 'dev' },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockScanPushForReverts).toHaveBeenCalledWith({
      repository: 'acme/api',
      branch: 'main',
      commits: [
        { sha: HEAD_SHA, message: 'Revert "feat: widgets (#123)"', timestamp: '2026-07-10T10:00:00Z' },
      ],
    });
  });
});
