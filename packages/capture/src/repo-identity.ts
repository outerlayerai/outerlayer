// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Repo identity resolution — the app join key. A transcript carries `cwd` and
 * (sometimes) `gitBranch`, but never the repo's stable identity. This resolves
 * the git remote + HEAD commit FROM the cwd at capture time (the filesystem is
 * authoritative then), so:
 *
 *   - many working dirs / worktrees of one repo collapse to ONE app
 *     (`~/dev/studio`, `~/dev/studio2`, `.../worktrees/agent-x` →
 *      `github.com/acme/app`), and
 *   - the branch + commit become the context-version key for A/B.
 *
 * Resolution shells out to git; results are memoized per directory (many
 * sessions share a cwd) and every failure degrades to `{}` — a session with no
 * resolvable repo lands in the "(unassigned)" bucket, never an error.
 */
import { execFileSync } from "node:child_process";
import type { AgentSession } from "@outerlayer/session-schema";

export interface RepoIdentity {
  /** Normalized remote, e.g. `github.com/acme/app`. */
  gitRepo?: string;
  /** HEAD commit sha at resolution time. */
  commitSha?: string;
  /** Current branch (fills gaps for adapters that don't capture it). */
  gitBranch?: string;
  /** Absolute working-tree root (`git rev-parse --show-toplevel`) — the anchor
   * for rendering in-repo paths repo-relative. Undefined outside a repo. */
  repoRoot?: string;
}

/** `git@github.com:acme/app.git`, `https://github.com/acme/app`,
 * `ssh://git@host/acme/app.git` → `github.com/acme/app`. */
export function normalizeRemote(remote: string): string | undefined {
  let r = remote.trim();
  if (!r) return undefined;
  r = r.replace(/^ssh:\/\//, "").replace(/^https?:\/\//, "").replace(/^git:\/\//, "");
  r = r.replace(/^[^@/]+@/, ""); // drop user@ (git@, ssh user)
  r = r.replace(/:/, "/"); // scp-style host:path → host/path
  r = r.replace(/\.git$/, "").replace(/\/+$/, "");
  return r || undefined;
}

const cache = new Map<string, RepoIdentity>();

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return undefined;
  }
}

/** Resolve repo identity from a directory. Memoized; never throws. */
export function resolveRepoIdentity(cwd: string | undefined): RepoIdentity {
  if (!cwd) return {};
  const cached = cache.get(cwd);
  if (cached) return cached;
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  const identity: RepoIdentity = {};
  if (remote) {
    const norm = normalizeRemote(remote);
    if (norm) identity.gitRepo = norm;
  }
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  if (sha) identity.commitSha = sha;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") identity.gitBranch = branch;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root) identity.repoRoot = root;
  cache.set(cwd, identity);
  return identity;
}

/**
 * Enrich a session's env with resolved repo identity, IN PLACE. Fills gitRepo
 * (the app key) and commitSha always; fills gitBranch only when the transcript
 * didn't already carry it (the transcript's branch is authoritative — it's the
 * branch at run time, not now). Returns the session for chaining.
 */
export function enrichSessionRepo(session: AgentSession): AgentSession {
  const id = resolveRepoIdentity(session.env.cwd);
  if (id.gitRepo) session.env.gitRepo = id.gitRepo;
  if (id.commitSha) session.env.commitSha = id.commitSha;
  if (id.gitBranch && !session.env.gitBranch) session.env.gitBranch = id.gitBranch;
  return session;
}
