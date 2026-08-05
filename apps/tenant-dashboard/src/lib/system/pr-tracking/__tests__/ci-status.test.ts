/**
 * recordFirstPassCiResult — the first-pass CI verdict on `pull_request`
 * rows. Supabase runs through MSW (no client mocks). Pins the two-write
 * compare-and-set protocol the verdict's integrity rests on: the sha lock
 * only lands where first_ci_sha IS NULL, and the failure escalation only
 * flips success → failure within the locked sha — never the reverse, never
 * on a later sha.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../test-helpers/msw-server';
import { recordFirstPassCiResult } from '../ci-status';

const logger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/observability/server-logger', () => ({ serverLogger: logger }));

const API = 'http://localhost:54321/rest/v1';
const SHA = 'f'.repeat(40);

let patches: Array<{ url: URL; body: Record<string, unknown> }>;

function seed(connections: Array<{ app_id: string }>) {
  server.use(
    http.get(`${API}/git_connection`, () => HttpResponse.json(connections)),
    http.patch(`${API}/pull_request`, async ({ request }) => {
      patches.push({ url: new URL(request.url), body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json([]);
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
});

describe('recordFirstPassCiResult', () => {
  it('a success locks the verdict onto the sha it arrived on, guarded by first_ci_sha IS NULL', async () => {
    seed([{ app_id: 'app-1' }]);

    await recordFirstPassCiResult({
      repository: 'acme/api',
      headSha: SHA,
      conclusion: 'success',
      completedAt: '2026-07-10T10:00:00Z',
    });

    // Success → the lock write only; no escalation write.
    expect(patches).toHaveLength(1);
    const { url, body } = patches[0]!;
    expect(body).toEqual({
      first_ci_sha: SHA,
      first_ci_status: 'success',
      first_ci_at: '2026-07-10T10:00:00Z',
    });
    expect(url.searchParams.get('app_id')).toBe('eq.app-1');
    expect(url.searchParams.get('head_sha')).toBe(`eq.${SHA}`);
    expect(url.searchParams.get('first_ci_sha')).toBe('is.null');
  });

  it('a failure also issues the escalation write: success → failure within the locked sha only', async () => {
    seed([{ app_id: 'app-1' }]);

    await recordFirstPassCiResult({
      repository: 'acme/api',
      headSha: SHA,
      conclusion: 'failure',
      completedAt: '2026-07-10T10:05:00Z',
    });

    expect(patches).toHaveLength(2);
    const [lock, escalate] = patches;
    expect(lock!.body).toEqual({
      first_ci_sha: SHA,
      first_ci_status: 'failure',
      first_ci_at: '2026-07-10T10:05:00Z',
    });
    // The escalation flips ONLY rows already locked to THIS sha with a green
    // verdict — a red verdict can never be un-failed, and a later sha's runs
    // can never rewrite the first pass.
    expect(escalate!.body).toEqual({ first_ci_status: 'failure' });
    expect(escalate!.url.searchParams.get('first_ci_sha')).toBe(`eq.${SHA}`);
    expect(escalate!.url.searchParams.get('first_ci_status')).toBe('eq.success');
  });

  it('matches by PR number when the event names one directly', async () => {
    seed([{ app_id: 'app-1' }]);

    await recordFirstPassCiResult({
      repository: 'acme/api',
      headSha: SHA,
      conclusion: 'success',
      prNumber: 42,
    });

    const { url } = patches[0]!;
    expect(url.searchParams.get('pr_number')).toBe('eq.42');
    expect(url.searchParams.get('head_sha')).toBeNull();
  });

  it('does nothing for an unconnected repository', async () => {
    seed([]);
    await recordFirstPassCiResult({ repository: 'stranger/repo', headSha: SHA, conclusion: 'failure' });
    expect(patches).toHaveLength(0);
  });

  it('logs and never throws when the lock write fails (best-effort webhook path)', async () => {
    server.use(
      http.get(`${API}/git_connection`, () => HttpResponse.json([{ app_id: 'app-1' }])),
      http.patch(`${API}/pull_request`, () => HttpResponse.json({ message: 'boom' }, { status: 500 }))
    );

    await expect(
      recordFirstPassCiResult({ repository: 'acme/api', headSha: SHA, conclusion: 'failure' })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
      expect.objectContaining({ context: '[CI Status] first-pass verdict lock failed', head_sha: SHA })
    );
  });
});
