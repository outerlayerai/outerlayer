/**
 * Tests for github/webhooks.ts — push event normalization.
 *
 * Mutation targets: the OptionalChaining + LogicalOperator + ArrowFunction
 * mutations on the safe-extract paths in normalizeGitHubPushEvent. The bug
 * classes those mutations represent:
 *
 *   - `payload.ref || ''` becomes `payload.ref && ''` → branch name silently
 *     becomes '' when ref is present
 *   - `payload.head_commit?.id || payload.after || ''` chain mutations →
 *     wrong commitSha source picked when head_commit is partial
 *   - `commit.author?.name || ''` → name becomes undefined when author is
 *     missing instead of safe empty string
 *   - `commit.added || []` falling back to undefined → downstream map/filter
 *     blows up
 *   - The default `new Date().toISOString()` timestamp fallback
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeGitHubPushEvent,
  type GitHubPushPayload,
} from '../webhooks';

function basePayload(overrides: Partial<GitHubPushPayload> = {}): GitHubPushPayload {
  return {
    ref: 'refs/heads/main',
    before: '0'.repeat(40),
    after: 'abcd123',
    repository: {
      id: 1,
      name: 'app',
      full_name: 'acme/app',
      private: false,
      default_branch: 'main',
    },
    head_commit: {
      id: 'head-sha',
      message: 'head commit',
      timestamp: '2026-05-29T10:00:00Z',
      author: { name: 'Alice', email: 'alice@example.com', username: 'alice' },
      committer: { name: 'Alice', email: 'alice@example.com' },
    },
    commits: [
      {
        id: 'commit-1-sha',
        message: 'first',
        timestamp: '2026-05-29T09:00:00Z',
        author: { name: 'Alice', email: 'alice@example.com', username: 'alice' },
        added: ['a.txt'],
        modified: ['b.txt'],
        removed: ['c.txt'],
      },
    ],
    sender: { id: 99, login: 'alice', type: 'User' },
    ...overrides,
  };
}

describe('normalizeGitHubPushEvent', () => {
  it('returns the canonical shape for a fully populated push event', () => {
    const out = normalizeGitHubPushEvent(basePayload());

    expect(out).toEqual({
      provider: 'github',
      repository: 'acme/app',
      branch: 'main',
      commitSha: 'head-sha',
      // The payload's `before` sha — the catch-up baseline comparison input.
      beforeSha: '0000000000000000000000000000000000000000',
      // The head commit's message, recorded on the sync event.
      commitMessage: 'head commit',
      commits: [
        {
          sha: 'commit-1-sha',
          message: 'first',
          author: {
            name: 'Alice',
            email: 'alice@example.com',
            username: 'alice',
          },
          added: ['a.txt'],
          modified: ['b.txt'],
          removed: ['c.txt'],
          timestamp: '2026-05-29T09:00:00Z',
        },
      ],
      sender: { username: 'alice', email: 'alice@example.com' },
      timestamp: '2026-05-29T10:00:00Z',
      raw: expect.objectContaining({ ref: 'refs/heads/main' }),
    });
  });

  it('strips the refs/heads/ prefix from the branch name', () => {
    const out = normalizeGitHubPushEvent(basePayload({ ref: 'refs/heads/feature/x-y' }));
    expect(out.branch).toBe('feature/x-y');
  });

  it('returns empty branch when ref is undefined', () => {
    const out = normalizeGitHubPushEvent(basePayload({ ref: undefined }));
    expect(out.branch).toBe('');
  });

  it('leaves the ref unchanged when it does not start with refs/heads/', () => {
    // Push to tag (refs/tags/...) — the replace is a no-op and the full ref
    // value flows through. Catches a mutation that replaces the wrong prefix.
    const out = normalizeGitHubPushEvent(basePayload({ ref: 'refs/tags/v1.0.0' }));
    expect(out.branch).toBe('refs/tags/v1.0.0');
  });

  it('falls back to payload.after when head_commit is missing', () => {
    // Force-push / branch-create deliveries may omit head_commit but
    // still carry `after`. This fallback chain is one of the most-mutated
    // expressions in the file.
    const out = normalizeGitHubPushEvent(
      basePayload({ head_commit: undefined, after: 'after-sha' }),
    );
    expect(out.commitSha).toBe('after-sha');
  });

  it('falls back to empty string when both head_commit and after are missing', () => {
    const out = normalizeGitHubPushEvent(
      basePayload({ head_commit: undefined, after: undefined }),
    );
    expect(out.commitSha).toBe('');
  });

  it('takes commitMessage from head_commit.message, null when head_commit is absent', () => {
    expect(normalizeGitHubPushEvent(basePayload()).commitMessage).toBe('head commit');
    expect(
      normalizeGitHubPushEvent(basePayload({ head_commit: undefined })).commitMessage,
    ).toBeNull();
  });

  it('prefers head_commit.id over payload.after when both are present', () => {
    // Pin the precedence: head_commit wins. A mutation that flips the
    // order would silently use the post-push tip from `after` even when
    // head_commit is authoritative.
    const out = normalizeGitHubPushEvent(basePayload({ after: 'after-sha' }));
    expect(out.commitSha).toBe('head-sha');
  });

  it('returns empty commits array when payload.commits is undefined', () => {
    const out = normalizeGitHubPushEvent(basePayload({ commits: undefined }));
    expect(out.commits).toEqual([]);
  });

  it('substitutes empty strings for missing commit.author fields', () => {
    // The `commit.author?.name || ''` defaults are what keep downstream
    // consumers (e.g. UI commit lists) from rendering "undefined".
    const out = normalizeGitHubPushEvent(
      basePayload({
        commits: [
          {
            id: 'orphan-sha',
            message: 'no author',
            // author intentionally omitted (Codespaces / web edits sometimes do this)
            added: [],
            modified: [],
            removed: [],
          },
        ],
      }),
    );
    expect(out.commits[0]?.author).toEqual({
      name: '',
      email: '',
      username: undefined,
    });
  });

  it('substitutes empty arrays for missing added/modified/removed lists', () => {
    const out = normalizeGitHubPushEvent(
      basePayload({
        commits: [
          {
            id: 'x',
            message: 'm',
            author: { name: 'a', email: 'a@x', username: 'a' },
            // added, modified, removed omitted
          },
        ],
      }),
    );
    expect(out.commits[0]?.added).toEqual([]);
    expect(out.commits[0]?.modified).toEqual([]);
    expect(out.commits[0]?.removed).toEqual([]);
  });

  it('substitutes empty string for missing commit.timestamp', () => {
    const out = normalizeGitHubPushEvent(
      basePayload({
        commits: [
          {
            id: 'x',
            message: 'm',
            author: { name: 'a', email: 'a@x', username: 'a' },
            added: [],
            modified: [],
            removed: [],
            // timestamp omitted
          },
        ],
      }),
    );
    expect(out.commits[0]?.timestamp).toBe('');
  });

  it('falls back to current ISO timestamp when head_commit.timestamp is missing', () => {
    // The `|| new Date().toISOString()` branch — exact value can't be
    // asserted but the shape (ISO 8601) and approximate freshness can.
    const before = Date.now();
    const out = normalizeGitHubPushEvent(
      basePayload({
        head_commit: {
          id: 'sha',
          message: 'm',
          // timestamp omitted
        },
      }),
    );
    const after = Date.now();
    const parsedTs = Date.parse(out.timestamp);
    expect(parsedTs).toBeGreaterThanOrEqual(before);
    expect(parsedTs).toBeLessThanOrEqual(after);
  });

  it('substitutes empty strings when repository.full_name and sender.login are missing', () => {
    const out = normalizeGitHubPushEvent(
      basePayload({
        repository: undefined,
        sender: undefined,
      }),
    );
    expect(out.repository).toBe('');
    expect(out.sender.username).toBe('');
  });

  it('uses head_commit.committer.email for sender.email (NOT the head_commit.author.email)', () => {
    // The handler intentionally reads sender.email from head_commit.committer
    // — committer is the GitHub user who applied the commit, which is what
    // we want for push attribution. A mutation that swaps to author.email
    // (the original commit creator, often different on merge commits) would
    // silently mis-attribute pushes from GitHub Web UI / rebase flows.
    const out = normalizeGitHubPushEvent(
      basePayload({
        head_commit: {
          id: 'sha',
          message: 'm',
          timestamp: '2026-05-29T10:00:00Z',
          author: { name: 'Bob', email: 'bob@author.example', username: 'bob' },
          committer: { name: 'Alice', email: 'alice@committer.example' },
        },
      }),
    );
    expect(out.sender.email).toBe('alice@committer.example');
  });

  it('forwards the original payload as `raw` (verbatim, not a copy)', () => {
    // Downstream consumers (e.g. audit log, debug surfaces) rely on having
    // the unmodified payload available. A mutation that swaps `raw` to a
    // transformed value would silently lose fields.
    const payload = basePayload();
    const out = normalizeGitHubPushEvent(payload);
    expect(out.raw).toBe(payload);
  });

  it('sets provider to the literal "github" string', () => {
    // Pinning the provider literal — catches BooleanLiteral / StringLiteral
    // mutations that would silently mis-route the event downstream.
    const out = normalizeGitHubPushEvent(basePayload());
    expect(out.provider).toBe('github');
  });
});
