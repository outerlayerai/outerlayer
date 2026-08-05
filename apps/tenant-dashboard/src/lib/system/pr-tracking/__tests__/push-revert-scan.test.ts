/**
 * scanPushForReverts — commit-message revert detection on push events, the
 * manual-`git revert` gap in body-based detection. Supabase runs through MSW
 * (no client mocks). Pins the guards the false-positive safety rests on:
 * merged-state + base-branch + reverted_at-IS-NULL filters on every update,
 * update-only semantics, and the zero-work fast path (a push naming no
 * revert never even looks up the repo's connections).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../test-helpers/msw-server';
import { scanPushForReverts } from '../push-revert-scan';

const logger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/observability/server-logger', () => ({ serverLogger: logger }));

const API = 'http://localhost:54321/rest/v1';
const SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';

let connectionLookups: number;
let patches: Array<{ url: URL; body: Record<string, unknown> }>;

function seed(connections: Array<{ app_id: string }>) {
  server.use(
    http.get(`${API}/git_connection`, () => {
      connectionLookups += 1;
      return HttpResponse.json(connections);
    }),
    http.patch(`${API}/pull_request`, async ({ request }) => {
      patches.push({ url: new URL(request.url), body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json([]);
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionLookups = 0;
  patches = [];
});

describe('scanPushForReverts', () => {
  it('flags the named PR with every guard: merged-only, base-branch match, first-revert-wins', async () => {
    seed([{ app_id: 'app-1' }]);

    await scanPushForReverts({
      repository: 'acme/api',
      branch: 'main',
      commits: [
        { sha: 'c1', message: 'Revert "feat: widgets (#123)"', timestamp: '2026-07-10T10:00:00Z' },
      ],
    });

    expect(patches).toHaveLength(1);
    const { url, body } = patches[0]!;
    expect(body).toEqual({ reverted_at: '2026-07-10T10:00:00Z' });
    expect(url.searchParams.get('app_id')).toBe('eq.app-1');
    expect(url.searchParams.get('pr_number')).toBe('eq.123');
    expect(url.searchParams.get('state')).toBe('eq.merged');
    expect(url.searchParams.get('base_branch')).toBe('eq.main');
    expect(url.searchParams.get('reverted_at')).toBe('is.null');
  });

  it('flags by head sha for "This reverts commit <sha>" messages, same guards', async () => {
    seed([{ app_id: 'app-1' }]);

    await scanPushForReverts({
      repository: 'acme/api',
      branch: 'develop',
      commits: [{ sha: 'c1', message: `Revert broken thing\n\nThis reverts commit ${SHA}.` }],
    });

    expect(patches).toHaveLength(1);
    const { url } = patches[0]!;
    expect(url.searchParams.get('head_sha')).toBe(`eq.${SHA}`);
    expect(url.searchParams.get('base_branch')).toBe('eq.develop');
    expect(url.searchParams.get('state')).toBe('eq.merged');
  });

  it('fans one revert out to every connected app, but each target only once per push', async () => {
    seed([{ app_id: 'app-1' }, { app_id: 'app-2' }]);

    await scanPushForReverts({
      repository: 'acme/api',
      branch: 'main',
      commits: [
        { sha: 'c1', message: 'Revert "feat: widgets (#123)"' },
        // Second commit naming the SAME PR — deduped, not a second update.
        { sha: 'c2', message: 'Revert "feat: widgets (#123)"' },
      ],
    });

    expect(patches).toHaveLength(2);
    expect(patches.map((p) => p.url.searchParams.get('app_id'))).toEqual(['eq.app-1', 'eq.app-2']);
  });

  it('does nothing at all for a push with no revert-shaped commits — not even a connection lookup', async () => {
    seed([{ app_id: 'app-1' }]);

    await scanPushForReverts({
      repository: 'acme/api',
      branch: 'main',
      commits: [{ sha: 'c1', message: 'feat: perfectly ordinary work (#99)' }],
    });

    expect(connectionLookups).toBe(0);
    expect(patches).toHaveLength(0);
  });

  it('logs and continues when an update fails (best-effort — never breaks push processing)', async () => {
    server.use(
      http.get(`${API}/git_connection`, () => HttpResponse.json([{ app_id: 'app-1' }])),
      http.patch(`${API}/pull_request`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    await expect(
      scanPushForReverts({
        repository: 'acme/api',
        branch: 'main',
        commits: [{ sha: 'c1', message: 'Revert "feat: widgets (#123)"' }],
      })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
      expect.objectContaining({ context: '[Push Revert Scan] revert flag by PR number failed', pr_number: 123 })
    );
  });
});
