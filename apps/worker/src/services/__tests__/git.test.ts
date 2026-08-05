/**
 * Git helpers: remote-URL normalization + the token-safety invariant (the token
 * must reach git only through the credential helper, never the remote URL),
 * porcelain parsing, and diff collection against a real temp repo (the diff
 * collector is what turns the agent's edits into the FileChange[] the server
 * lands, so nothing downstream can recover from it being wrong).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  buildRemoteUrl,
  credentialHelperArgs,
  collectWorkingTreeDiff,
  DiffTooLargeError,
  parsePorcelainZ,
  scrubAuthFromStderr,
} from '../git.js';

const execFileAsync = promisify(execFile);

/** The `local` provider carries no credentials — the temp bare repos need none. */
const LOCAL_AUTH = { token: 'unused', provider: 'local' } as const;

/** Run `git credential fill` under an isolated HOME and return its stdout. */
function gitCredentialFill(home: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...credentialHelperArgs('github'), 'credential', 'fill'],
      {
        cwd: home,
        env: { PATH: process.env.PATH ?? '', HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_REPO_TOKEN: token },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.end('protocol=https\nhost=github.com\n\n');
  });
}

describe('buildRemoteUrl', () => {
  it('normalizes a bare owner/repo onto the default host', () => {
    expect(buildRemoteUrl('owner/repo', 'github')).toBe('https://github.com/owner/repo');
    expect(buildRemoteUrl('group.with.dots/proj', 'github')).toBe(
      'https://github.com/group.with.dots/proj',
    );
  });

  it('preserves a full https URL host and does not double-prefix', () => {
    expect(buildRemoteUrl('https://github.com/o/r', 'github')).toBe('https://github.com/o/r');
  });

  it('returns a local provider URL verbatim', () => {
    expect(buildRemoteUrl('/tmp/bare.git', 'local')).toBe('/tmp/bare.git');
    expect(buildRemoteUrl('file:///tmp/bare.git', 'local')).toBe('file:///tmp/bare.git');
  });
});

describe('credentialHelperArgs', () => {
  it('clears inherited helpers first, then supplies one that reads the env var', () => {
    expect(credentialHelperArgs('github')).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      expect.stringContaining('$GIT_REPO_TOKEN'),
    ]);
  });

  it('configures nothing for the local provider', () => {
    expect(credentialHelperArgs('local')).toEqual([]);
  });

  it('makes git answer with the token from the env and nothing from disk', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-cred-'));
    try {
      // A host-configured helper that would persist the token to disk. The
      // leading `credential.helper=` must neutralize it.
      await fs.writeFile(
        path.join(home, '.gitconfig'),
        `[credential]\n\thelper = store --file ${path.join(home, 'creds')}\n`,
      );
      const stdout = await gitCredentialFill(home, 'ghs_from_env_only');
      expect(stdout).toContain('username=x-access-token');
      expect(stdout).toContain('password=ghs_from_env_only');
      // The neutralized `store` helper never got a chance to write it out.
      await expect(fs.readFile(path.join(home, 'creds'), 'utf8')).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('scrubAuthFromStderr', () => {
  it('redacts embedded credentials but keeps the actionable diagnostic', () => {
    const input =
      "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r/': 403";
    expect(scrubAuthFromStderr(input)).toBe(
      "fatal: unable to access 'https://***:***@github.com/o/r/': 403",
    );
    expect(scrubAuthFromStderr(input)).not.toContain('ghs_secret');
  });
});

describe('parsePorcelainZ', () => {
  it('parses adds, modifies, deletes and skips the rename source path', () => {
    // "R  new\0old" is a rename: new path first, source second.
    const raw = 'A  added.ts\0 M modified.ts\0 D deleted.ts\0R  renamed.ts\0old.ts\0';
    expect(parsePorcelainZ(raw)).toEqual([
      { path: 'added.ts', index: 'A', worktree: ' ' },
      { path: 'modified.ts', index: ' ', worktree: 'M' },
      { path: 'deleted.ts', index: ' ', worktree: 'D' },
      { path: 'renamed.ts', index: 'R', worktree: ' ' },
    ]);
  });
});

describe('collectWorkingTreeDiff', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-git-test-'));
    const git = (args: string[]) => execFileAsync('git', args, { cwd: repo });
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@local']);
    await git(['config', 'user.name', 'test']);
    await fs.writeFile(path.join(repo, 'keep.ts'), 'original\n');
    await fs.writeFile(path.join(repo, 'gone.ts'), 'delete me\n');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'init']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('captures an untracked add, a modify, and a delete as WorkerFileChange[]', async () => {
    await fs.writeFile(path.join(repo, 'new.ts'), 'brand new\n');
    await fs.writeFile(path.join(repo, 'keep.ts'), 'modified\n');
    await fs.rm(path.join(repo, 'gone.ts'));

    const changes = await collectWorkingTreeDiff(repo, { maxDiffFiles: 100, maxDiffBytes: 1_000_000 });
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));

    expect(byPath['new.ts']).toEqual({ path: 'new.ts', operation: 'write', content: 'brand new\n', encoding: 'utf8' });
    expect(byPath['keep.ts']).toEqual({ path: 'keep.ts', operation: 'write', content: 'modified\n', encoding: 'utf8' });
    expect(byPath['gone.ts']).toEqual({ path: 'gone.ts', operation: 'delete', encoding: 'utf8' });
    expect(changes).toHaveLength(3);
  });

  it('returns an empty array when the agent changed nothing', async () => {
    expect(await collectWorkingTreeDiff(repo, { maxDiffFiles: 100, maxDiffBytes: 1_000_000 })).toEqual([]);
  });

  it('base64-encodes a binary file', async () => {
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const changes = await collectWorkingTreeDiff(repo, { maxDiffFiles: 100, maxDiffBytes: 1_000_000 });
    const blob = changes.find((c) => c.path === 'blob.bin');
    expect(blob).toEqual({ path: 'blob.bin', operation: 'write', content: 'AAEC/w==', encoding: 'base64' });
  });

  it('throws DiffTooLargeError past the file-count cap', async () => {
    await fs.writeFile(path.join(repo, 'a.ts'), 'a');
    await fs.writeFile(path.join(repo, 'b.ts'), 'b');
    await expect(
      collectWorkingTreeDiff(repo, { maxDiffFiles: 1, maxDiffBytes: 1_000_000 }),
    ).rejects.toBeInstanceOf(DiffTooLargeError);
  });

  it('throws DiffTooLargeError past the byte cap', async () => {
    await fs.writeFile(path.join(repo, 'big.ts'), 'x'.repeat(1000));
    await expect(
      collectWorkingTreeDiff(repo, { maxDiffFiles: 100, maxDiffBytes: 100 }),
    ).rejects.toBeInstanceOf(DiffTooLargeError);
  });
});

describe('persistent-turn git helpers', () => {
  let dir: string;
  let bare: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-persist-git-'));
    bare = path.join(root, 'origin.git');
    dir = path.join(root, 'ws');
    await execFileAsync('git', ['init', '-q', '--bare', bare]);
    await execFileAsync('git', ['clone', '-q', bare, dir]);
    const g = (a: string[]) => execFileAsync('git', a, { cwd: dir });
    await g(['config', 'user.email', 's@l']);
    await g(['config', 'user.name', 's']);
    await fs.writeFile(path.join(dir, 'README.md'), '# seed\n');
    await g(['add', '-A']);
    await g(['commit', '-qm', 'init']);
    await g(['branch', '-M', 'main']);
    await g(['push', '-q', 'origin', 'main']);
  });
  afterEach(async () => {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('checkoutWorkBranch creates the branch from base on the first turn, reuses it after', async () => {
    const { checkoutWorkBranch, commitAndPushTurn } = await import('../git.js');
    await checkoutWorkBranch(dir, 'outerlayer/worker/feat', 'main');
    let cur = (await execFileAsync('git', ['branch', '--show-current'], { cwd: dir })).stdout.trim();
    expect(cur).toBe('outerlayer/worker/feat');

    // Turn 1 commit + push.
    await fs.writeFile(path.join(dir, 'a.ts'), 'a\n');
    expect(await commitAndPushTurn(dir, 'outerlayer/worker/feat', 'turn 1', LOCAL_AUTH)).toBe(true);

    // Simulate a later turn: switch away, then checkoutWorkBranch reuses it.
    await execFileAsync('git', ['checkout', 'main'], { cwd: dir });
    await checkoutWorkBranch(dir, 'outerlayer/worker/feat', 'main');
    cur = (await execFileAsync('git', ['branch', '--show-current'], { cwd: dir })).stdout.trim();
    expect(cur).toBe('outerlayer/worker/feat');
    // a.ts from turn 1 is present (persistent branch state).
    expect((await execFileAsync('git', ['log', '--oneline'], { cwd: dir })).stdout).toContain('turn 1');
  });

  it('commitAndPushTurn returns false and does not create a commit when nothing changed', async () => {
    const { checkoutWorkBranch, commitAndPushTurn } = await import('../git.js');
    await checkoutWorkBranch(dir, 'outerlayer/worker/x', 'main');
    const before = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout.trim();
    expect(await commitAndPushTurn(dir, 'outerlayer/worker/x', 'empty turn', LOCAL_AUTH)).toBe(false);
    const after = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout.trim();
    expect(after).toBe(before);
  });

  it('pushes the work branch to origin so it is durable beyond the workspace', async () => {
    const { checkoutWorkBranch, commitAndPushTurn } = await import('../git.js');
    await checkoutWorkBranch(dir, 'outerlayer/worker/dur', 'main');
    await fs.writeFile(path.join(dir, 'b.ts'), 'b\n');
    await commitAndPushTurn(dir, 'outerlayer/worker/dur', 'turn', LOCAL_AUTH);
    const branches = (await execFileAsync('git', ['branch'], { cwd: bare })).stdout;
    expect(branches).toContain('outerlayer/worker/dur');
  });
});

describe('cloneRepo', () => {
  let root: string;
  let bare: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-clone-'));
    bare = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    await execFileAsync('git', ['init', '-q', '--bare', bare]);
    await execFileAsync('git', ['clone', '-q', bare, seed]);
    const g = (a: string[]) => execFileAsync('git', a, { cwd: seed });
    await g(['config', 'user.email', 's@l']);
    await g(['config', 'user.name', 's']);
    await fs.writeFile(path.join(seed, 'README.md'), '# seed\n');
    await g(['add', '-A']);
    await g(['commit', '-qm', 'init']);
    await g(['branch', '-M', 'main']);
    await g(['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shallow-clones the requested branch of a local repo into the target dir', async () => {
    const { cloneRepo } = await import('../git.js');
    const target = path.join(root, 'ws');
    await cloneRepo({ repoUrl: bare, branch: 'main', token: 'unused', provider: 'local', targetDir: target });
    expect(await fs.readFile(path.join(target, 'README.md'), 'utf8')).toBe('# seed\n');
  });

  it('throws a GitCloneError (not the raw command) when the repo does not exist', async () => {
    const { cloneRepo, GitCloneError } = await import('../git.js');
    const promise = cloneRepo({
      repoUrl: path.join(root, 'does-not-exist.git'),
      branch: 'main',
      token: 'unused',
      provider: 'local',
      targetDir: path.join(root, 'ws2'),
    });
    await expect(promise).rejects.toBeInstanceOf(GitCloneError);
    // Node's raw "Command failed: git clone <url>" message must never surface.
    await expect(promise).rejects.toThrow(/git clone failed/);
    await expect(promise).rejects.not.toThrow(/Command failed/);
  });
});

describe('checkoutWorkBranch fallback + commitAndPushTurn push failure', () => {
  let root: string;
  let bare: string;
  let dir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-ckout-'));
    bare = path.join(root, 'origin.git');
    dir = path.join(root, 'ws');
    await execFileAsync('git', ['init', '-q', '--bare', bare]);
    await execFileAsync('git', ['clone', '-q', bare, dir]);
    const g = (a: string[]) => execFileAsync('git', a, { cwd: dir });
    await g(['config', 'user.email', 's@l']);
    await g(['config', 'user.name', 's']);
    await fs.writeFile(path.join(dir, 'README.md'), '# seed\n');
    await g(['add', '-A']);
    await g(['commit', '-qm', 'init']);
    await g(['branch', '-M', 'main']);
    await g(['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the work branch from HEAD when the named base branch does not exist', async () => {
    const { checkoutWorkBranch } = await import('../git.js');
    await checkoutWorkBranch(dir, 'outerlayer/worker/nb', 'no-such-base');
    const cur = (await execFileAsync('git', ['branch', '--show-current'], { cwd: dir })).stdout.trim();
    expect(cur).toBe('outerlayer/worker/nb');
  });

  it('throws a scrubbed push error when the remote is unreachable and there were changes', async () => {
    const { checkoutWorkBranch, commitAndPushTurn } = await import('../git.js');
    await checkoutWorkBranch(dir, 'outerlayer/worker/pf', 'main');
    await fs.writeFile(path.join(dir, 'change.ts'), 'x\n');
    // Remove the origin so the push cannot succeed; the local commit still happens.
    await fs.rm(bare, { recursive: true, force: true });
    await expect(commitAndPushTurn(dir, 'outerlayer/worker/pf', 'turn with changes', LOCAL_AUTH)).rejects.toThrow(
      /push work branch failed/,
    );
    // But the commit was made locally before the push was attempted.
    expect((await execFileAsync('git', ['log', '--oneline'], { cwd: dir })).stdout).toContain('turn with changes');
  });
});
