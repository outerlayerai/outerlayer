/**
 * Git operations the runner performs directly: clone the tenant repo, and
 * collect the agent's working-tree diff as a WorkerFileChange[] (server-side
 * landing turns that into a branch + PR). The URL builder scrubs the token
 * out of stderr — it must never reach an error string.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitChildEnv } from '../lib/child-env.js';
import type { WorkerFileChange } from '../lib/schemas.js';

const execFileAsync = promisify(execFile);

/** Redact `scheme://user:pw@` userinfo from any string before it is surfaced. */
export function scrubAuthFromStderr(input: string): string {
  return input.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1***:***@');
}

/**
 * Normalize a repo URL into the remote the workspace will carry. It holds NO
 * credentials: whatever git writes to `remote.origin.url` is readable by the
 * agent that then runs in this workspace, and `.git/config` outlives the turn on
 * a persistent environment. Credentials travel separately, via
 * `credentialHelperArgs` below.
 *
 * The `local` provider (dev/tests) is returned verbatim — a file:// or absolute
 * path to a bare repo.
 */
export function buildRemoteUrl(repoUrl: string, provider: 'github' | 'local'): string {
  if (provider === 'local') return repoUrl;

  const hasProtocol = /^https?:\/\//i.test(repoUrl);
  const urlWithoutProtocol = repoUrl.replace(/^https?:\/\//i, '');
  const defaultHost = 'github.com';
  const hostAndPath =
    hasProtocol || urlWithoutProtocol.startsWith(`${defaultHost}/`)
      ? urlWithoutProtocol
      : `${defaultHost}/${urlWithoutProtocol}`;
  return `https://${hostAndPath}`;
}

/**
 * `git -c` args that feed the token to one git invocation and nowhere else.
 *
 * The first (empty) value clears any inherited helper, so a host-configured
 * store/osxkeychain helper can't persist the token to disk. The second reads it
 * from `GIT_REPO_TOKEN` in the child env — the helper body in argv is a literal
 * `$GIT_REPO_TOKEN`, expanded by the shell git spawns, so the token itself never
 * appears in a process listing.
 *
 * These must be passed BEFORE the subcommand: `git -c ... clone` applies the
 * config to this invocation only, whereas `git clone -c ...` would write it into
 * the new repo's `.git/config`.
 */
export function credentialHelperArgs(provider: 'github' | 'local'): string[] {
  if (provider === 'local') return [];
  return [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!f() { if test "$1" = get; then echo username=x-access-token; echo "password=$GIT_REPO_TOKEN"; fi; }; f',
  ];
}

export class GitCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCloneError';
  }
}

/** Clone one branch, shallow. Errors are token-scrubbed. */
export async function cloneRepo(opts: {
  repoUrl: string;
  branch: string;
  token: string;
  provider: 'github' | 'local';
  targetDir: string;
}): Promise<void> {
  const url = buildRemoteUrl(opts.repoUrl, opts.provider);
  try {
    await execFileAsync(
      'git',
      [
        ...credentialHelperArgs(opts.provider),
        'clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', opts.branch, url, opts.targetDir,
      ],
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env: gitChildEnv(process.env, opts.token) },
    );
  } catch (err) {
    // NEVER include err.message — Node formats it as "Command failed: git
    // clone <url> ...", which echoes the whole command line. The scrub is the
    // second layer: git itself prints userinfo-bearing URLs from submodules and
    // redirects.
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer; signal?: string; killed?: boolean };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '');
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    const detail =
      scrubAuthFromStderr(stderr)
        .trim()
        .split('\n')
        .filter((line) => !line.startsWith('Cloning into '))
        .slice(-5)
        .join(' | ') || '(no stderr output)';
    throw new GitCloneError(`${timedOut ? 'git clone timed out' : 'git clone failed'}: ${detail}`);
  }
}

/** Check out (creating if needed) the work branch a persistent env accumulates on. */
export async function checkoutWorkBranch(
  repoDir: string,
  workBranch: string,
  baseBranch: string,
): Promise<void> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: repoDir, env: gitChildEnv() });
  await git(['config', 'user.email', 'workers@agentmark.co']).catch(() => undefined);
  await git(['config', 'user.name', 'AgentMark Worker']).catch(() => undefined);
  // If the branch already exists (later turns), switch to it; else create from base.
  try {
    await git(['checkout', workBranch]);
  } catch {
    await git(['checkout', '-b', workBranch, baseBranch]).catch(async () => {
      await git(['checkout', '-b', workBranch]);
    });
  }
}

/**
 * Commit everything in the workspace as a turn checkpoint and push the work
 * branch to origin. Returns true if a commit was made (there were changes).
 * Token-safe: errors are scrubbed.
 */
export async function commitAndPushTurn(
  repoDir: string,
  workBranch: string,
  message: string,
  auth: { token: string; provider: 'github' | 'local' },
): Promise<boolean> {
  // Local git work gets no token at all; only the push carries one.
  const git = (args: string[]) => execFileAsync('git', args, { cwd: repoDir, env: gitChildEnv() });
  const push = () =>
    execFileAsync('git', [...credentialHelperArgs(auth.provider), 'push', '-u', 'origin', workBranch], {
      cwd: repoDir,
      env: gitChildEnv(process.env, auth.token),
    });
  await git(['add', '-A']);
  const { stdout } = await git(['status', '--porcelain']);
  if (!stdout.trim()) {
    // Nothing changed this turn — still ensure the branch is pushed.
    try {
      await push();
    } catch {
      // best-effort; branch may already be up to date
    }
    return false;
  }
  await git(['commit', '-m', message.slice(0, 72)]);
  try {
    await push();
  } catch (err) {
    const e = err as { stderr?: string | Buffer };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '');
    throw new Error(`push work branch failed: ${scrubAuthFromStderr(stderr).slice(-300)}`);
  }
  return true;
}

/** Parse `git status --porcelain=v1 -z` into changed paths + status codes. */
export function parsePorcelainZ(
  stdout: string,
): Array<{ path: string; index: string; worktree: string }> {
  const out: Array<{ path: string; index: string; worktree: string }> = [];
  // -z separates entries with NUL. Renames/copies emit a second NUL-delimited
  // path (the source) which we consume but don't report as its own change.
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const index = entry[0] ?? ' ';
    const worktree = entry[1] ?? ' ';
    const filePath = entry.slice(3);
    if (index === 'R' || index === 'C') {
      // Rename/copy: the NEXT part is the source path — skip it.
      i += 1;
    }
    out.push({ path: filePath, index, worktree });
  }
  return out;
}

export interface DiffCollectionCaps {
  maxDiffFiles: number;
  maxDiffBytes: number;
}

export class DiffTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffTooLargeError';
  }
}

/**
 * Collect the agent's working-tree changes (staged + unstaged + untracked)
 * relative to the clone's HEAD as WorkerFileChange[]. Binary files ride as
 * base64. Enforces the file-count and total-byte caps, throwing
 * DiffTooLargeError rather than truncating.
 */
export async function collectWorkingTreeDiff(
  repoDir: string,
  caps: DiffCollectionCaps,
): Promise<WorkerFileChange[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: repoDir, maxBuffer: 50 * 1024 * 1024, env: gitChildEnv() },
  );
  const entries = parsePorcelainZ(stdout);
  if (entries.length > caps.maxDiffFiles) {
    throw new DiffTooLargeError(
      `agent changed ${entries.length} files, over the ${caps.maxDiffFiles}-file cap`,
    );
  }

  const changes: WorkerFileChange[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const deleted = entry.index === 'D' || entry.worktree === 'D';
    if (deleted) {
      changes.push({ path: entry.path, operation: 'delete', encoding: 'utf8' });
      continue;
    }
    const abs = path.join(repoDir, entry.path);
    const buf = await fs.readFile(abs);
    totalBytes += buf.byteLength;
    if (totalBytes > caps.maxDiffBytes) {
      throw new DiffTooLargeError(
        `agent diff exceeds the ${caps.maxDiffBytes}-byte cap`,
      );
    }
    // Treat a file as binary if it contains a NUL byte in its first 8000 bytes
    // — git's own heuristic.
    const sniff = buf.subarray(0, 8000);
    const isBinary = sniff.includes(0);
    changes.push(
      isBinary
        ? { path: entry.path, operation: 'write', content: buf.toString('base64'), encoding: 'base64' }
        : { path: entry.path, operation: 'write', content: buf.toString('utf8'), encoding: 'utf8' },
    );
  }
  return changes;
}
