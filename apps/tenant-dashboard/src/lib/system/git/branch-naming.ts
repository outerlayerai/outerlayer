import "server-only";

/**
 * Head-branch naming for `createCommitWithFallback` PRs.
 *
 * A publish that opens a PR cuts a fresh, legibly-named side branch off the
 * connected branch. The name is `<prefix>/<slug>-<suffix>` (or `<prefix>-<suffix>`
 * when no slug is given), where the suffix guarantees uniqueness so repeated
 * publishes of the same prompt never collide on a branch ref.
 */

import type { CommitFallbackOptions } from './types';

const DEFAULT_PREFIX = 'outerlayer/dataset';
const MAX_SLUG_LENGTH = 60;

/**
 * The `environment.name` CHECK (`52-environment.sql`): a lowercase letter
 * followed by 1–39 of `[a-z0-9-]` (2–40 chars total). A preview branch name
 * must satisfy this so it can double as the env name.
 */
const ENV_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** True when `name` is usable verbatim as a git ref segment AND an env name. */
export function isValidPreviewBranchName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

/**
 * The preview env name for a PR's head branch. The publish flow validates the
 * user-provided branch up front, so it's used verbatim; for an arbitrary
 * (human-authored) head branch we sanitize, and fall back to `pr-<n>` when even
 * that can't yield a valid env name (e.g. a branch starting with a digit).
 */
export function toPreviewEnvName(headBranch: string, prNumber: number): string {
  if (isValidPreviewBranchName(headBranch)) return headBranch;
  const slug = sanitizeBranchSegment(headBranch).slice(0, 40).replace(/-+$/g, '');
  return isValidPreviewBranchName(slug) ? slug : `pr-${prNumber}`;
}

/**
 * Sanitize an arbitrary string into a single git-ref-safe path segment:
 * lowercase, only `[a-z0-9-]`, no leading/trailing/repeated hyphens, capped.
 * Git ref rules forbid spaces, `..`, `~^:?*[`, control chars, and trailing
 * `/` or `.lock`; collapsing to `[a-z0-9-]` sidesteps all of them.
 */
export function sanitizeBranchSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Sanitize a multi-segment branch/ref path, preserving `/` boundaries — each
 * segment is made git-ref-safe on its own. Empty segments (leading, trailing,
 * or doubled slashes) are dropped. Used for stable head-branch names derived
 * from a target branch, where the `/` structure must survive (unlike
 * {@link sanitizeBranchSegment}, which flattens the whole string).
 */
export function sanitizeBranchPath(input: string): string {
  return input.split('/').map(sanitizeBranchSegment).filter(Boolean).join('/');
}

/**
 * Build the side-branch name for a fallback/forced PR. Defaults preserve the
 * historical `outerlayer/dataset-<ts>` name; prompt/template publishes pass
 * `headBranchPrefix: 'outerlayer/publish'` + a slug for `outerlayer/publish/<slug>-<ts>`.
 */
export function buildFallbackBranchName(options?: CommitFallbackOptions): string {
  // A caller-provided branch name is used verbatim (validated up front) — no
  // prefix, no random suffix — so it doubles as the preview env name and a
  // re-publish lands on the SAME branch (→ updates the PR, not a new one).
  // Sanitized per segment so a slashed stable name (e.g.
  // `outerlayer/context/main`) keeps its structure rather than flattening.
  if (options?.headBranchName) {
    return sanitizeBranchPath(options.headBranchName);
  }
  const prefix = options?.headBranchPrefix ?? DEFAULT_PREFIX;
  const suffix = Date.now().toString(36);
  const slug = options?.headBranchSlug
    ? sanitizeBranchSegment(options.headBranchSlug)
    : '';
  return slug ? `${prefix}/${slug}-${suffix}` : `${prefix}-${suffix}`;
}
