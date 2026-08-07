/**
 * The PR-comment repository canonicalizer. This is the one place that
 * decides a comment's identity key, and it is shared by the queue producer,
 * the queue consumer, and the dashboard orchestrator — two spellings of one
 * repository would mean two identity rows and therefore two comments on one
 * PR (AC-057-02). Strictness matters more than tolerance here: a guess is a
 * duplicate comment in a customer's repo, a null is a loud failure.
 */
import { describe, it, expect } from 'vitest';

import { canonicalPrCommentRepo } from './pr-comment-repo-key';

describe('canonicalPrCommentRepo', () => {
  it('passes through the bare owner/repo the webhook and cron sweep use', () => {
    expect(canonicalPrCommentRepo('acme/api')).toBe('acme/api');
  });

  it('strips the host qualifier ClickHouse GitRepo carries (the queue path)', () => {
    expect(canonicalPrCommentRepo('github.com/acme/api')).toBe('acme/api');
  });

  it.each([
    ['https://github.com/acme/api', 'acme/api'],
    ['https://www.github.com/acme/api', 'acme/api'],
    ['github.com/acme/api.git', 'acme/api'],
    ['  acme/api  ', 'acme/api'],
    ['github.com/acme/api/', 'acme/api'],
    ['acme/my.repo-name_2', 'acme/my.repo-name_2'],
  ])('normalizes %s', (input, expected) => {
    expect(canonicalPrCommentRepo(input)).toBe(expected);
  });

  it.each([
    // A GHES host must NOT be silently reduced to owner/repo — the feature
    // is GitHub.com-only, and a plausible-looking key is the failure that
    // posts a second comment.
    'git.acme-enterprise.com/acme/api',
    'https://gitlab.com/acme/api',
    'git@github.com:acme/api.git',
    '/Users/someone/code/api',
    'acme',
    'acme/api/extra',
    '',
  ])('refuses %s rather than guessing', (input) => {
    expect(canonicalPrCommentRepo(input)).toBeNull();
  });

  it('refuses null and undefined', () => {
    expect(canonicalPrCommentRepo(null)).toBeNull();
    expect(canonicalPrCommentRepo(undefined)).toBeNull();
  });

  it('is idempotent — re-canonicalizing an already-canonical key is a no-op', () => {
    const once = canonicalPrCommentRepo('github.com/acme/api');
    expect(canonicalPrCommentRepo(once)).toBe(once);
  });
});
