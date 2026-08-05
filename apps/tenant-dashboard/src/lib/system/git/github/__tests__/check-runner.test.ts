/**
 * Tests for the GitHub Checks API implementation of {@link CheckRunner}.
 *
 * The check reports the context-mirror sync outcome (aggregate across watching
 * apps), so the runner is a thin renderer: `start()` opens an in-progress
 * check; `complete()` closes it with a conclusion + the caller's aggregate
 * summary (or a per-conclusion default). Per the tenant-dashboard rule we don't
 * mock Octokit — the MSW server records the actual requests Octokit emits and
 * we assert against those.
 */

import { describe, it, expect } from 'vitest';
import { Octokit } from 'octokit';
import { GitHubCheckRunner, CHECK_NAME } from '../check-runner';
import {
  seedGithubChecksMswState,
  getCreatedCheckRuns,
  getUpdatedCheckRuns,
} from '../../../../../test-helpers/msw-handlers';

const TARGET = { owner: 'acme', repo: 'prompts' };
const HEAD_SHA = 'a'.repeat(40);

function makeRunner(): GitHubCheckRunner {
  // Raw Octokit with a placeholder token — MSW intercepts the HTTP call
  // before Octokit's auth ever leaves the test process.
  return new GitHubCheckRunner(new Octokit({ auth: 'test-token' }), TARGET);
}

// ─── GitHubCheckRunner.start ───────────────────────────────────────────────

describe('GitHubCheckRunner.start', () => {
  it('posts an in-progress check run under the stable check name and returns the minted id', async () => {
    seedGithubChecksMswState({ nextCheckRunId: 42 });

    const ref = await makeRunner().start(HEAD_SHA);

    expect(ref).toEqual({ id: 42 });
    const created = getCreatedCheckRuns();
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      owner: 'acme',
      repo: 'prompts',
      id: 42,
      body: expect.objectContaining({
        name: CHECK_NAME,
        head_sha: HEAD_SHA,
        status: 'in_progress',
        started_at: expect.any(String),
      }),
    });
  });

  it('propagates Checks API errors so the caller can decide whether to swallow', async () => {
    seedGithubChecksMswState({
      forceCreateError: { status: 403, message: 'Resource not accessible by integration' },
    });

    await expect(makeRunner().start(HEAD_SHA)).rejects.toThrow(
      /Resource not accessible/,
    );
  });
});

// ─── GitHubCheckRunner.complete ────────────────────────────────────────────

describe('GitHubCheckRunner.complete', () => {
  it('renders the caller aggregate summary verbatim on success, no annotations', async () => {
    await makeRunner().complete({
      ref: { id: 99 },
      conclusion: 'success',
      summary: '✓ acme-app: synced abc1234',
    });

    const updated = getUpdatedCheckRuns();
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({
      owner: 'acme',
      repo: 'prompts',
      checkRunId: 99,
      body: expect.objectContaining({
        status: 'completed',
        conclusion: 'success',
        completed_at: expect.any(String),
        output: {
          title: 'Context synced',
          summary: '✓ acme-app: synced abc1234',
        },
      }),
    });
    // The check is a single completed PATCH — no annotation batching anymore.
    expect(
      (updated[0]!.body.output as Record<string, unknown>),
    ).not.toHaveProperty('annotations');
  });

  it('falls back to a per-conclusion default summary when the caller passes none', async () => {
    await makeRunner().complete({ ref: { id: 100 }, conclusion: 'neutral' });

    const [update] = getUpdatedCheckRuns();
    expect(update!.body.conclusion).toBe('neutral');
    expect(update!.body.output).toEqual({
      title: 'Nothing to sync',
      summary: 'No app is watching this branch — nothing to sync.',
    });
  });

  it('completes a failed sync with the failure title and the per-app error summary', async () => {
    await makeRunner().complete({
      ref: { id: 7 },
      conclusion: 'failure',
      summary: '✕ acme-app: clone timed out',
    });

    const [update] = getUpdatedCheckRuns();
    expect(update!.body.status).toBe('completed');
    expect(update!.body.conclusion).toBe('failure');
    expect(update!.body.output).toEqual({
      title: 'Context sync failed',
      summary: '✕ acme-app: clone timed out',
    });
  });
});
