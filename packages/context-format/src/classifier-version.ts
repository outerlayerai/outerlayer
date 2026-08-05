/**
 * Stamped onto every `context_snapshot` row so a classifier
 * change can trigger a lazy resync instead of requiring a data migration:
 * `UNIQUE(app_id, commit_sha, classifier_version)` means a version bump
 * makes every existing snapshot's key miss, so the next sync for that app
 * naturally rebuilds against the new classifier.
 *
 * Bump this whenever a change to `classifyTree` (or anything it depends on
 * — `path-utils.ts`, the frontmatter kind rules) would classify an
 * unchanged tree differently: a new/renamed `ContextKind`, a change to
 * scope/shadowing resolution, a change to what counts as "excluded". Do
 * NOT bump for changes that don't affect classification output (bug fixes
 * to unrelated exports, test-only changes, comments).
 */
export const CLASSIFIER_VERSION = 3;
