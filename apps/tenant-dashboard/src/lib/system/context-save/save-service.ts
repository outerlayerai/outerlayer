import "server-only";

/**
 * Context save-path service.
 *
 * Shared core behind the three context write operations (save/create/delete
 * — see `features/context/actions/`). Every dependency is an injected port
 * so this is testable with no Supabase and no real git provider.
 *
 * Scope guard: no mirror writes happen anywhere in this file
 * — the `mirror` port is read-only (staleness check + skill-dir path
 * enumeration). The webhook-fed mirror sync is the only writer.
 *
 * Known limitation: the check-then-commit window between a remote
 * read (`git.getFileContent` / the directory walk below) and
 * `git.createCommitWithFallback` is not atomic — provider tree-commit APIs
 * take no per-file expected sha. The window is seconds; the webhook mirror
 * sync plus a UI re-check on open narrow it further. Do not attempt
 * provider-level compare-and-swap here.
 */

import {
  classifyPublishValidation,
  classifyTree,
  type ContextKind,
  type FieldIssue,
} from "@repo/context-core";
import {
  PATH_MAX_LEN,
  SEGMENT_MAX_LEN,
  pathExceedsLengthLimits,
} from "@/lib/path-limits";
import { isGitProviderError } from "../git/errors";
import { sanitizeBranchPath } from "../git/branch-naming";
import type { GitProvider } from "../git/git-provider.interface";
import type { CommitAuthor, FileChange } from "../git/types";
import { mapWithConcurrency } from "../git/utils";

/** Bounds in-flight per-file git API calls during a batch commit (conflict-check fallback, blob creation). */
const GIT_BATCH_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface GitConnectionPort {
  /** Resolves the app's git provider + repo + connected branch, or null if the app has no git connection. */
  loadForApp(
    appId: string
  ): Promise<{ provider: GitProvider; repository: string; branch: string } | null>;
}

export interface PolicyPort {
  loadForApp(appId: string): Promise<{ requirePullRequest: boolean }>;
}

export interface MirrorReadPort {
  /** Blob sha of `path` at the mirror's current head for `branch`, or null when the path isn't in the mirror. */
  headBlobSha(appId: string, branch: string, path: string): Promise<string | null>;
  /** Every mirrored content path under `dirPrefix` (e.g. a skill directory) at the mirror's current head. */
  snapshotPaths(appId: string, branch: string, dirPrefix: string): Promise<string[]>;
}

export interface SaveServicePorts {
  connection: GitConnectionPort;
  policy: PolicyPort;
  mirror: MirrorReadPort;
}

// ---------------------------------------------------------------------------
// Shared result / failure types
// ---------------------------------------------------------------------------

export type ContextSaveResult =
  | { landed: "branch"; commitSha: string; branch: string }
  | {
      landed: "pull_request";
      commitSha: string;
      pullRequestUrl: string;
      pullRequestNumber: number;
      /** Whether a fresh PR was opened or an accumulating PR was updated. */
      prAction: "created" | "updated";
      /** Why the change went to a PR: the publish policy (`config`) or a protected branch. */
      reason: "config" | "protected_branch";
      branch: string;
    };

interface ContextSaveSuccess {
  status: "saved";
  result: ContextSaveResult;
  warnings: FieldIssue[];
  /**
   * Skill assets/scripts deleted alongside the skill's content files that the
   * mirror never tracked — set only for a `skillDir` delete, so the UI
   * can name them in its warning without re-deriving the walk.
   */
  deletedAssetPaths?: string[];
}

export interface ContextSaveValidationFailure {
  status: "validation_error";
  errors: FieldIssue[];
}

export interface ContextSaveConflictFailure {
  status: "conflict";
  path: string;
  remoteSha: string | null;
  /** `exists` is create-specific: the path already has content at head. */
  reason: "modified" | "deleted" | "exists";
}

export interface ContextSaveConnectionFailure {
  status: "not_connected";
}

export interface ContextSaveGitErrorFailure {
  status: "git_error";
  message: string;
}

export type ContextSaveOutcome =
  | ContextSaveSuccess
  | ContextSaveValidationFailure
  | ContextSaveConflictFailure
  | ContextSaveConnectionFailure
  | ContextSaveGitErrorFailure;

/** One file's stale-base conflict within a multi-file commit (same tri-state as the single-file path). */
export interface ContextBatchFileConflict {
  path: string;
  remoteSha: string | null;
  /** `exists` is create-specific (baseBlobSha null): the path already has content at head. */
  reason: "modified" | "deleted" | "exists";
}

/**
 * Every file that failed schema/mcp validation in a batch, keyed by path — a
 * single invalid file blocks the whole commit (nothing is written), and the
 * caller surfaces each file's errors against its row.
 */
export interface ContextBatchValidationFailure {
  status: "validation_error";
  fileErrors: Array<{ path: string; errors: FieldIssue[] }>;
}

/** Every stale-base conflict in a batch, collected together (the commit never fires while any exist). */
export interface ContextBatchConflictFailure {
  status: "conflict";
  conflicts: ContextBatchFileConflict[];
}

/**
 * Outcome of a multi-file commit. A separate union from {@link
 * ContextSaveOutcome} so the single-file consumers keep their exact shapes:
 * validation and conflict failures here carry per-file detail (a batch fails
 * as a whole, but the UI names which files and why).
 */
export type ContextBatchCommitOutcome =
  | ContextSaveSuccess
  | ContextBatchValidationFailure
  | ContextBatchConflictFailure
  | ContextSaveConnectionFailure
  | ContextSaveGitErrorFailure;

export interface ContextActor {
  name: string;
  email: string;
}

/**
 * Committer identity for every context save/create/delete commit.
 *
 * No surviving precedent for a per-user `CommitAuthor` exists in
 * `services/git/` (no caller of `createCommit`/`createCommitWithFallback`
 * sets one from an acting user — grepped clean, both are currently uncalled
 * in production code). Commits use this fixed
 * app-connection identity; the real actor is recorded in a `Saved-by:`
 * commit-body trailer instead (see `buildCommitMessage`).
 */
export const APP_CONNECTION_COMMIT_AUTHOR: CommitAuthor = {
  name: "OuterLayer",
  email: "hello@outerlayer.ai",
};

const CONTEXT_HEAD_BRANCH_PREFIX = "outerlayer/context";
const MAX_COMMIT_MESSAGE_LENGTH = 200;
/** Fallback subject for a multi-file commit when the user leaves the message empty. */
const DEFAULT_BATCH_COMMIT_SUBJECT = "Update context files";

/**
 * The stable head branch every context PR for `targetBranch` accumulates on:
 * `outerlayer/context/<sanitized target>`. Keyed by repo + target branch (not
 * by app or by content), so repeated saves reuse one PR and two apps sharing a
 * repo + target branch intentionally share the same PR — they resolve to the
 * same repo tree, so their context lives in one place.
 */
function contextHeadBranchName(targetBranch: string): string {
  return `${CONTEXT_HEAD_BRANCH_PREFIX}/${sanitizeBranchPath(targetBranch)}`;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Single-path classification via `classifyTree`.
 *
 * `@repo/context-core` deliberately does not export a single-path
 * classifier (see `classify.ts`: "no incremental single-path classification
 * is exported ... the single-path primitive ... is an internal
 * implementation detail, not part of the public API") because shadowing and
 * skill-grouping issues need the whole tree. Classifying a single path never
 * depends on siblings, though, so `classifyTree([path]).entries[0]` yields
 * the identical `kind`/`scopePath`/`skillName` the tree-wide call would —
 * just without cross-entry issues (shadowing, missing-SKILL.md), which are
 * not relevant here (this validates one file for one save, not a tree).
 */
function classifySinglePath(
  path: string
): { kind: ContextKind; scopePath: string; skillName?: string } | null {
  const { entries } = classifyTree([path]);
  const entry = entries[0];
  if (!entry) return null;
  return entry;
}

function fileStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/** The `<name>` in `context: <verb> <kind> <name>`. */
function contentName(
  path: string,
  kind: ContextKind,
  skillName: string | undefined
): string {
  if (kind === "skill" || kind === "skill-reference") return skillName ?? fileStem(path);
  return fileStem(path);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedContent {
  kind: ContextKind;
  scopePath: string;
  skillName?: string;
  warnings: FieldIssue[];
}

/**
 * True when a path contains a `..` parent-dir segment. The classifier's
 * `normalizePath` deliberately keeps `..` (it operates on trusted git-tree /
 * classifier-produced paths), so a crafted client path like
 * `.outerlayer/../secret/x.md` would otherwise classify and commit OUTSIDE the
 * scope's `.outerlayer/`. Every client-supplied path is rejected at the save/
 * delete boundary here before any classification or git write.
 */
function hasParentTraversal(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").some((seg) => seg === "..");
}

function pathTraversalError(path: string): FieldIssue[] {
  return [{ path: "(path)", code: "path_traversal", message: `"${path}" must not contain a ".." path segment` }];
}

/**
 * A created path over the checkout-safe caps (any segment > 64, or total > 180).
 * Enforced only on CREATE — edits and deletes of pre-existing long paths must
 * still succeed. Mirrors the client create surfaces' cap so both agree.
 */
function pathLengthError(path: string): FieldIssue[] {
  const longSegment = path.split("/").find((seg) => seg.length > SEGMENT_MAX_LEN);
  const message = longSegment
    ? `path segment "${longSegment}" exceeds the ${SEGMENT_MAX_LEN}-character limit`
    : `"${path}" exceeds the ${PATH_MAX_LEN}-character path limit`;
  return [{ path: "(path)", code: "path_too_long", message }];
}

function unclassifiedPathError(path: string): FieldIssue[] {
  return [{ path: "(path)", code: "unclassified_path", message: `"${path}" is not a recognized context file path` }];
}

function validateContent(
  path: string,
  content: string,
  isCreate: boolean,
): ValidatedContent | { errors: FieldIssue[] } {
  if (hasParentTraversal(path)) return { errors: pathTraversalError(path) };
  if (isCreate && pathExceedsLengthLimits(path)) return { errors: pathLengthError(path) };
  const classified = classifySinglePath(path);
  if (!classified) {
    return { errors: unclassifiedPathError(path) };
  }

  const { kind, scopePath, skillName } = classified;

  // Two-tier gate (shared with the publish dialog): warning-tier files (empty
  // description and other fixable field lints) commit with warnings; only
  // hard errors block.
  const result = classifyPublishValidation(kind, content, {
    dirName: kind === "skill" ? skillName : undefined,
    fileStem: kind === "subagent" ? fileStem(path) : undefined,
  });
  if (!result.ok) return { errors: result.errors };
  return { kind, scopePath, skillName, warnings: result.warnings };
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

/** Caps to a single line and `MAX_COMMIT_MESSAGE_LENGTH` chars — user-supplied messages are used verbatim otherwise. */
function sanitizeUserCommitMessage(message: string): string {
  const firstLine = message.split("\n")[0] ?? "";
  return firstLine.slice(0, MAX_COMMIT_MESSAGE_LENGTH);
}

function defaultCommitSubject(verb: string, kind: ContextKind, name: string): string {
  return `context: ${verb} ${kind} ${name}`;
}

/** Appends the acting-user trailer below the subject, per plan #5 (app-connection identity + `Saved-by:` body trailer). */
function buildCommitMessage(subject: string, actor: ContextActor): string {
  return `${subject}\n\nSaved-by: ${actor.name} <${actor.email}>`;
}

// ---------------------------------------------------------------------------
// Save / create (shared core — verb + conflict semantics derive from baseBlobSha)
// ---------------------------------------------------------------------------

export interface SaveContextFileInput {
  appId: string;
  path: string;
  content: string;
  /** `null` = create (path must not exist at head); non-null = update (must match remote head exactly). */
  baseBlobSha: string | null;
  commitMessage?: string;
  actor: ContextActor;
}

export async function saveContextFile(
  ports: SaveServicePorts,
  input: SaveContextFileInput
): Promise<ContextSaveOutcome> {
  const validated = validateContent(input.path, input.content, input.baseBlobSha === null);
  if ("errors" in validated) {
    return { status: "validation_error", errors: validated.errors };
  }

  const conn = await ports.connection.loadForApp(input.appId);
  if (!conn) return { status: "not_connected" };
  const { provider, repository, branch } = conn;

  const isCreate = input.baseBlobSha === null;

  try {
    const remoteSha = await getRemoteSha(provider, repository, input.path, branch);

    if (isCreate) {
      if (remoteSha !== null) {
        return { status: "conflict", path: input.path, remoteSha, reason: "exists" };
      }
    } else {
      if (remoteSha === null) {
        return { status: "conflict", path: input.path, remoteSha: null, reason: "deleted" };
      }
      if (remoteSha !== input.baseBlobSha) {
        return { status: "conflict", path: input.path, remoteSha, reason: "modified" };
      }
    }

    const policy = await ports.policy.loadForApp(input.appId);
    const verb = isCreate ? "create" : "update";
    const name = contentName(input.path, validated.kind, validated.skillName);
    const subject = input.commitMessage
      ? sanitizeUserCommitMessage(input.commitMessage)
      : defaultCommitSubject(verb, validated.kind, name);
    const message = buildCommitMessage(subject, input.actor);

    const changes: FileChange[] = [
      { path: input.path, content: input.content, operation: isCreate ? "create" : "update" },
    ];

    const commitResult = await provider.createCommitWithFallback(
      repository,
      changes,
      message,
      branch,
      APP_CONNECTION_COMMIT_AUTHOR,
      {
        forcePullRequest: policy.requirePullRequest,
        headBranchName: contextHeadBranchName(branch),
        pullRequestTitle: `Context changes for ${branch}`,
      }
    );

    return {
      status: "saved",
      result: toContextSaveResult(commitResult, branch, policy.requirePullRequest),
      warnings: validated.warnings,
    };
  } catch (err) {
    return { status: "git_error", message: gitErrorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Multi-file commit (N files, ONE atomic commit)
// ---------------------------------------------------------------------------

export interface CommitContextChangesFile {
  path: string;
  content: string;
  /** `null` = create (path must not exist at head); non-null = update/delete (must match remote head). */
  baseBlobSha: string | null;
  /**
   * `true` stages a deletion of `path` in this batch: `content` is ignored and
   * `baseBlobSha` is the conflict base the path must still match at head. A
   * delete skips content validation and the create-only length cap (a
   * pre-existing long path stays deletable), but the `..` traversal guard still
   * applies.
   */
  delete?: boolean;
}

export interface CommitContextChangesInput {
  appId: string;
  /** Optional user-supplied subject; falls back to a fixed default. */
  message?: string;
  files: CommitContextChangesFile[];
  actor: ContextActor;
}

/**
 * Commits N context files as ONE atomic commit (create + update + delete
 * mixed). Mirrors the single-file path's semantics — full validation, then a
 * per-path stale-base conflict check with the same tri-state — but aggregates:
 * a single invalid file or a single conflict blocks the whole commit and every
 * offending file is reported together, so the UI resolves them in one pass
 * rather than one round-trip per file. A `delete` file skips content validation
 * (its content is empty) and conflicts against its pinned base like an update
 * (`modified` on drift, `deleted` when already gone). The conflict check and
 * the commit are not atomic — a concurrent write can land between them; do not
 * add provider compare-and-swap.
 */
export async function commitContextChanges(
  ports: SaveServicePorts,
  input: CommitContextChangesInput
): Promise<ContextBatchCommitOutcome> {
  if (input.files.length === 0) {
    return {
      status: "validation_error",
      fileErrors: [{ path: "(files)", errors: [{ path: "(files)", code: "empty_commit", message: "no files to commit" }] }],
    };
  }

  // One path can't carry two operations in a single tree commit — reject a
  // batch that names the same path twice before any validation or git work.
  const seenPaths = new Set<string>();
  const duplicatePaths = new Set<string>();
  for (const file of input.files) {
    if (seenPaths.has(file.path)) duplicatePaths.add(file.path);
    seenPaths.add(file.path);
  }
  if (duplicatePaths.size > 0) {
    return {
      status: "validation_error",
      fileErrors: [...duplicatePaths].map((path) => ({
        path,
        errors: [{ path, code: "duplicate_path", message: `"${path}" appears more than once in this commit` }],
      })),
    };
  }

  const validated: Array<{ file: CommitContextChangesFile; kind: ContextKind; skillName?: string; warnings: FieldIssue[] }> = [];
  const fileErrors: Array<{ path: string; errors: FieldIssue[] }> = [];
  for (const file of input.files) {
    if (file.delete) {
      // A deletion writes no content, so full content validation and the
      // create-only length cap are skipped — but the path itself is NOT
      // exempt: a classifiable path (AGENTS.md, a command, a skill file) is a
      // valid delete target, and so is an unclassifiable one PROVIDED it still
      // sits under a scope's `.outerlayer/` (a skill's asset/script — files
      // `classifyTree` intentionally doesn't classify). A path that is
      // BOTH unclassifiable AND outside every `.outerlayer/` is out of scope
      // entirely — `classifySinglePath` returning null for it is not
      // permission to delete an arbitrary repo file (`package.json`,
      // `README.md`, CI config), so that combination is rejected here rather
      // than treated the same as an in-scope skill asset.
      if (hasParentTraversal(file.path)) {
        fileErrors.push({ path: file.path, errors: pathTraversalError(file.path) });
      } else {
        const classified = classifySinglePath(file.path);
        if (!classified && !file.path.split("/").includes(".outerlayer")) {
          fileErrors.push({ path: file.path, errors: unclassifiedPathError(file.path) });
        } else {
          validated.push({ file, kind: classified?.kind ?? "reference", skillName: classified?.skillName, warnings: [] });
        }
      }
      continue;
    }
    const result = validateContent(file.path, file.content, file.baseBlobSha === null);
    if ("errors" in result) {
      fileErrors.push({ path: file.path, errors: result.errors });
    } else {
      validated.push({ file, kind: result.kind, skillName: result.skillName, warnings: result.warnings });
    }
  }
  if (fileErrors.length > 0) return { status: "validation_error", fileErrors };

  const conn = await ports.connection.loadForApp(input.appId);
  if (!conn) return { status: "not_connected" };
  const { provider, repository, branch } = conn;

  try {
    // One bulk tree listing covers every staged path's remote sha, folded in
    // file order so the conflict list is deterministic for the UI's rows.
    const remoteShas = await loadRemoteShas(
      provider,
      repository,
      validated.map(({ file }) => file.path),
      branch,
    );
    const conflicts: ContextBatchFileConflict[] = [];
    validated.forEach(({ file }) => {
      const remoteSha = remoteShas.get(file.path) ?? null;
      if (file.delete) {
        // A staged delete conflicts like an update: already gone at head is
        // `deleted`, drifted from the pinned base is `modified`.
        if (remoteSha === null) {
          conflicts.push({ path: file.path, remoteSha: null, reason: "deleted" });
        } else if (remoteSha !== file.baseBlobSha) {
          conflicts.push({ path: file.path, remoteSha, reason: "modified" });
        }
      } else if (file.baseBlobSha === null) {
        if (remoteSha !== null) conflicts.push({ path: file.path, remoteSha, reason: "exists" });
      } else if (remoteSha === null) {
        conflicts.push({ path: file.path, remoteSha: null, reason: "deleted" });
      } else if (remoteSha !== file.baseBlobSha) {
        conflicts.push({ path: file.path, remoteSha, reason: "modified" });
      }
    });
    if (conflicts.length > 0) return { status: "conflict", conflicts };

    const policy = await ports.policy.loadForApp(input.appId);
    const subject = input.message
      ? sanitizeUserCommitMessage(input.message)
      : DEFAULT_BATCH_COMMIT_SUBJECT;
    const message = buildCommitMessage(subject, input.actor);

    const changes: FileChange[] = validated.map(({ file }) => ({
      path: file.path,
      content: file.delete ? "" : file.content,
      operation: file.delete ? "delete" : file.baseBlobSha === null ? "create" : "update",
    }));

    const commitResult = await provider.createCommitWithFallback(
      repository,
      changes,
      message,
      branch,
      APP_CONNECTION_COMMIT_AUTHOR,
      {
        forcePullRequest: policy.requirePullRequest,
        headBranchName: contextHeadBranchName(branch),
        pullRequestTitle: `Context changes for ${branch}`,
      }
    );

    return {
      status: "saved",
      result: toContextSaveResult(commitResult, branch, policy.requirePullRequest),
      warnings: validated.flatMap((v) => v.warnings),
    };
  } catch (err) {
    return { status: "git_error", message: gitErrorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Skill-directory deletion enumeration
// ---------------------------------------------------------------------------

export interface SkillDeletionEnumeration {
  /** Every path to delete — mirrored content files plus non-mirrored assets/scripts, deduped and sorted. */
  paths: string[];
  /**
   * The subset NOT tracked by the mirror (skill assets/scripts — the
   * mirror only records a per-skill count for these). Surfaced so a caller
   * (the delete confirmation UI) can name them in its warning.
   */
  assetPaths: string[];
  /**
   * Blob sha per path, read live during THIS enumeration — the conflict base a
   * caller stages each path's delete draft against. Covers every entry in
   * `paths` (content and assets alike): the live git walk sees the whole
   * directory, so it needs no separate read for the mirrored subset. A path
   * missing here (the provider omitted its sha) is not a valid delete target.
   */
  shas: Record<string, string>;
}

export type SkillDeletionEnumerationOutcome =
  | { status: "ok"; enumeration: SkillDeletionEnumeration }
  | { status: "not_connected" }
  | { status: "git_error"; message: string };

/**
 * Recursively lists every file path (with its blob sha) under `dirPath` via
 * per-directory `GitProvider.listDirectory` calls — one round trip per
 * subdirectory level. Slow path: kept as the fallback for when the bulk tree
 * listing throws past the provider's safety cap (see {@link listFilesUnderDir}).
 */
async function walkDirectoryFiles(
  provider: GitProvider,
  repository: string,
  dirPath: string,
  ref: string
): Promise<Array<{ path: string; sha?: string }>> {
  const entries = await provider.listDirectory(repository, dirPath, ref);
  const files: Array<{ path: string; sha?: string }> = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      files.push({ path: entry.path, sha: entry.sha });
    } else {
      files.push(...(await walkDirectoryFiles(provider, repository, entry.path, ref)));
    }
  }
  return files;
}

/**
 * Lists every file under `dirPath` in one bulk `GitProvider.listTree` call,
 * filtered to the directory's prefix — a single round trip instead of one
 * `listDirectory` call per subdirectory level. Falls back to the slower
 * {@link walkDirectoryFiles} recursion when `listTree` throws (the provider's
 * tree safety cap on an oversized repo).
 */
async function listFilesUnderDir(
  provider: GitProvider,
  repository: string,
  dirPath: string,
  ref: string
): Promise<Array<{ path: string; sha?: string }>> {
  const prefix = `${dirPath.replace(/\/+$/, "")}/`;
  try {
    const blobs = await provider.listTree(repository, ref);
    return blobs.filter((b) => b.path.startsWith(prefix)).map((b) => ({ path: b.path, sha: b.sha }));
  } catch {
    return walkDirectoryFiles(provider, repository, dirPath, ref);
  }
}

/**
 * Merges the mirror's content-path listing (`mirror.snapshotPaths`, fast but
 * blind to assets/scripts) with a live tree listing of `skillDir` at the
 * connected branch's head (authoritative, sees everything, and the only
 * source of a blob sha for non-mirrored assets) — the complete set of paths a
 * skill- or generic-directory delete must remove.
 * Exported standalone so a delete-confirmation UI can call it ahead of the
 * actual delete to render the warning and pin each path's delete draft to a
 * live conflict base.
 */
export async function enumerateSkillDeletion(
  ports: SaveServicePorts,
  appId: string,
  skillDir: string
): Promise<SkillDeletionEnumerationOutcome> {
  const conn = await ports.connection.loadForApp(appId);
  if (!conn) return { status: "not_connected" };

  try {
    const [mirrored, live] = await Promise.all([
      ports.mirror.snapshotPaths(appId, conn.branch, skillDir),
      listFilesUnderDir(conn.provider, conn.repository, skillDir, conn.branch),
    ]);
    const mirroredSet = new Set(mirrored);
    const livePaths = live.map((f) => f.path);
    const assetPaths = livePaths.filter((p) => !mirroredSet.has(p)).sort();
    const paths = [...new Set([...mirrored, ...livePaths])].sort();
    const shas = Object.fromEntries(
      live.filter((f): f is { path: string; sha: string } => f.sha !== undefined).map((f) => [f.path, f.sha]),
    );
    return { status: "ok", enumeration: { paths, assetPaths, shas } };
  } catch (err) {
    return { status: "git_error", message: gitErrorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Shared git helpers
// ---------------------------------------------------------------------------

/** Returns the file's remote content sha, or null when it doesn't exist at `ref`. */
async function getRemoteSha(
  provider: GitProvider,
  repository: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const file = await provider.getFileContent(repository, path, ref);
    return file.sha;
  } catch (err) {
    if (isGitProviderError(err) && err.code === "FILE_NOT_FOUND") return null;
    throw err;
  }
}

/**
 * Resolves every path's remote blob sha (`null` when absent at `ref`) in one
 * bulk `GitProvider.listTree` call — the same git blob-sha space
 * `getRemoteSha` reads one file at a time, so tree-listed and per-file shas
 * compare interchangeably. Falls back to bounded-concurrency per-file reads when `listTree`
 * throws (the provider's oversized-repo tree cap), so a batch still resolves
 * without ever holding more than {@link GIT_BATCH_CONCURRENCY} per-file
 * requests in flight.
 */
async function loadRemoteShas(
  provider: GitProvider,
  repository: string,
  paths: string[],
  ref: string,
): Promise<Map<string, string | null>> {
  try {
    const blobs = await provider.listTree(repository, ref);
    const blobShaByPath = new Map(blobs.map((b) => [b.path, b.sha]));
    return new Map(paths.map((path) => [path, blobShaByPath.get(path) ?? null]));
  } catch {
    const shas = await mapWithConcurrency(paths, GIT_BATCH_CONCURRENCY, (path) =>
      getRemoteSha(provider, repository, path, ref),
    );
    return new Map(paths.map((path, i) => [path, shas[i] ?? null]));
  }
}

function toContextSaveResult(
  commitResult: Awaited<ReturnType<GitProvider["createCommitWithFallback"]>>,
  branch: string,
  requirePullRequest: boolean
): ContextSaveResult {
  if (commitResult.landed === "pull_request") {
    // The provider reports why it fell back; when it doesn't, derive it from the
    // publish policy (a forced PR is `config`, a rejected direct push is a
    // protected branch).
    const reason: "config" | "protected_branch" =
      commitResult.fallbackReason === "forced"
        ? "config"
        : commitResult.fallbackReason === "protected_branch"
          ? "protected_branch"
          : requirePullRequest
            ? "config"
            : "protected_branch";
    return {
      landed: "pull_request",
      commitSha: commitResult.commit.sha,
      pullRequestUrl: commitResult.pullRequestUrl!,
      pullRequestNumber: commitResult.pullRequestNumber!,
      prAction: commitResult.pullRequestAction ?? "created",
      reason,
      branch,
    };
  }
  return { landed: "branch", commitSha: commitResult.commit.sha, branch };
}

function gitErrorMessage(err: unknown): string {
  if (isGitProviderError(err)) return err.message;
  return err instanceof Error ? err.message : "Unexpected git error";
}
