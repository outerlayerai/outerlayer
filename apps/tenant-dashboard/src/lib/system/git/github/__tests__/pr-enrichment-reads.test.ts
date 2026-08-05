/**
 * GitHub provider — the two API reads behind the PR-enrichment backfill.
 *
 * Drives the REAL provider against MSW-intercepted Octokit calls and pins:
 *   1. per-PR diff stats come from the single-PR GET (the list endpoint
 *      omits them), nulls when absent — unknown, never 0;
 *   2. the commit CI verdict is a FAILURE-STICKY worst-of over check runs
 *      (the fastest green check must not shadow the failing suite),
 *      say-nothing conclusions are ignored, and a sha with no
 *      signal-bearing run is null — unknown, never a pass.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Octokit } from 'octokit';
import { server } from '../../../../../test-helpers/msw-server';
import { GitHubProvider } from '../client';

const REPO = 'acme/repo';
const API = 'https://api.github.com/repos/acme/repo';
const SHA = 'a'.repeat(40);

function provider() {
  return new GitHubProvider(new Octokit({ auth: 'test-token' }));
}

describe('GitHubProvider.getPullRequestDiffStats', () => {
  it('reads additions/deletions/changed_files off the single-PR GET', async () => {
    server.use(
      http.get(`${API}/pulls/7`, () =>
        HttpResponse.json({ additions: 120, deletions: 30, changed_files: 5 })
      )
    );
    expect(await provider().getPullRequestDiffStats(REPO, 7)).toEqual({
      additions: 120,
      deletions: 30,
      changedFiles: 5,
    });
  });

  it('returns nulls (never zeros) when the payload lacks the fields', async () => {
    server.use(http.get(`${API}/pulls/7`, () => HttpResponse.json({})));
    expect(await provider().getPullRequestDiffStats(REPO, 7)).toEqual({
      additions: null,
      deletions: null,
      changedFiles: null,
    });
  });
});

describe('GitHubProvider.getCommitCiVerdict', () => {
  it('is failure-sticky: one failing run outvotes any number of green ones', async () => {
    server.use(
      http.get(`${API}/commits/${SHA}/check-runs`, () =>
        HttpResponse.json({
          check_runs: [
            { conclusion: 'success', completed_at: '2026-07-10T10:00:00Z' },
            { conclusion: 'failure', completed_at: '2026-07-10T10:05:00Z' },
            { conclusion: 'success', completed_at: '2026-07-10T10:01:00Z' },
          ],
        })
      )
    );
    expect(await provider().getCommitCiVerdict(REPO, SHA)).toEqual({
      conclusion: 'failure',
      // Earliest SIGNAL-BEARING completion — mirrors the live path's
      // first-conclusion timestamp.
      completedAt: '2026-07-10T10:00:00Z',
    });
  });

  it('maps timed_out/startup_failure to failure and all-green to success', async () => {
    server.use(
      http.get(`${API}/commits/${SHA}/check-runs`, () =>
        HttpResponse.json({
          check_runs: [{ conclusion: 'timed_out', completed_at: '2026-07-10T10:00:00Z' }],
        })
      )
    );
    expect((await provider().getCommitCiVerdict(REPO, SHA)).conclusion).toBe('failure');

    server.use(
      http.get(`${API}/commits/${SHA}/check-runs`, () =>
        HttpResponse.json({
          check_runs: [{ conclusion: 'success', completed_at: '2026-07-10T10:00:00Z' }],
        })
      )
    );
    expect((await provider().getCommitCiVerdict(REPO, SHA)).conclusion).toBe('success');
  });

  it('ignores say-nothing conclusions entirely — a sha with only those is null, never a pass', async () => {
    server.use(
      http.get(`${API}/commits/${SHA}/check-runs`, () =>
        HttpResponse.json({
          check_runs: [
            { conclusion: 'cancelled', completed_at: '2026-07-10T10:00:00Z' },
            { conclusion: 'skipped', completed_at: '2026-07-10T10:01:00Z' },
            { conclusion: 'neutral', completed_at: '2026-07-10T10:02:00Z' },
            { conclusion: null, completed_at: null },
          ],
        })
      )
    );
    expect(await provider().getCommitCiVerdict(REPO, SHA)).toEqual({
      conclusion: null,
      completedAt: null,
    });
  });
});
