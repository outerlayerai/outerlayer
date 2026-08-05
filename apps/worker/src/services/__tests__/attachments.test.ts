/**
 * Attachment materialization. The git-exclusion tests run
 * against a REAL git repo in a temp dir — the bug class that matters most
 * here is an uploaded file leaking into the collected diff (and from there
 * into the tenant's PR), and only real `git status` proves the exclusion.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ATTACHMENTS_DIR_NAME,
  appendAttachmentsToTask,
  materializeAttachments,
  sanitizeAttachmentFileName,
} from '../attachments.js';
import { collectWorkingTreeDiff } from '../git.js';

const execFileAsync = promisify(execFile);

const roots: string[] = [];

async function makeGitWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'attach-ws-'));
  roots.push(ws);
  const g = (args: string[]) => execFileAsync('git', args, { cwd: ws });
  await g(['init', '-q']);
  await g(['config', 'user.email', 't@l']);
  await g(['config', 'user.name', 't']);
  await fs.writeFile(path.join(ws, 'README.md'), '# repo\n');
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  return ws;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => undefined)));
});

describe('sanitizeAttachmentFileName', () => {
  it.each([
    ['plain name unchanged', 'screenshot.png', 'screenshot.png'],
    ['strips directory traversal', '../../../etc/passwd', 'passwd'],
    ['strips windows-style paths', '..\\..\\evil.png', 'evil.png'],
    ['replaces unsafe characters', 'my file (v2)!.png', 'my-file-v2-.png'],
    ['strips a leading dot (no hidden files)', '.env', 'env'],
    ['dot-only names fall back', '...', 'attachment'],
    ['empty names fall back', '', 'attachment'],
  ])('%s', (_name, input, expected) => {
    expect(sanitizeAttachmentFileName(input)).toBe(expected);
  });

  it('bounds length to 80 characters, keeping the extension end of the name', () => {
    const sanitized = sanitizeAttachmentFileName(`${'a'.repeat(120)}.png`);
    expect(sanitized.length).toBeLessThanOrEqual(80);
    expect(sanitized.endsWith('.png')).toBe(true);
  });
});

describe('materializeAttachments', () => {
  it('writes exact bytes under the per-run directory and reports workspace-relative paths', async () => {
    const ws = await makeGitWorkspace();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10]);
    const materialized = await materializeAttachments({
      workspace: ws,
      workerRunId: 'abcdef12-3456',
      attachments: [{ name: 'logo.png', mime: 'image/png', content: bytes.toString('base64') }],
    });

    expect(materialized).toEqual([
      {
        relPath: `${ATTACHMENTS_DIR_NAME}/abcdef12/logo.png`,
        name: 'logo.png',
        mime: 'image/png',
        sizeBytes: 6,
      },
    ]);
    const onDisk = await fs.readFile(path.join(ws, materialized[0]!.relPath));
    expect(Buffer.compare(onDisk, bytes)).toBe(0);
  });

  it('keeps traversal names inside the attachments directory', async () => {
    const ws = await makeGitWorkspace();
    const [m] = await materializeAttachments({
      workspace: ws,
      workerRunId: 'run-trav',
      attachments: [{ name: '../../outside.txt', mime: 'text/plain', content: Buffer.from('x').toString('base64') }],
    });
    expect(m!.relPath).toBe(`${ATTACHMENTS_DIR_NAME}/run-trav/outside.txt`);
    // Nothing escaped above the workspace.
    await expect(fs.access(path.join(ws, '..', 'outside.txt'))).rejects.toThrow();
  });

  it('suffixes name collisions so every attachment survives', async () => {
    const ws = await makeGitWorkspace();
    const materialized = await materializeAttachments({
      workspace: ws,
      workerRunId: 'run-coll',
      attachments: [
        { name: 'report.pdf', mime: 'application/pdf', content: Buffer.from('one').toString('base64') },
        { name: 'report.pdf', mime: 'application/pdf', content: Buffer.from('two').toString('base64') },
      ],
    });
    expect(materialized.map((m) => m.relPath)).toEqual([
      `${ATTACHMENTS_DIR_NAME}/run-coll/report.pdf`,
      `${ATTACHMENTS_DIR_NAME}/run-coll/report-1.pdf`,
    ]);
    expect(await fs.readFile(path.join(ws, materialized[1]!.relPath), 'utf8')).toBe('two');
  });

  it('keeps materialized attachments OUT of the collected working-tree diff (real git)', async () => {
    const ws = await makeGitWorkspace();
    await materializeAttachments({
      workspace: ws,
      workerRunId: 'run-diff',
      attachments: [{ name: 'evidence.png', mime: 'image/png', content: Buffer.from('img').toString('base64') }],
    });
    // A real agent edit IS collected; the attachment is not.
    await fs.writeFile(path.join(ws, 'src.ts'), 'export {};\n');

    const changes = await collectWorkingTreeDiff(ws, { maxDiffFiles: 50, maxDiffBytes: 1_000_000 });
    expect(changes).toEqual([
      { path: 'src.ts', operation: 'write', content: 'export {};\n', encoding: 'utf8' },
    ]);
  });

  it('appends the git exclude line exactly once across repeated turns', async () => {
    const ws = await makeGitWorkspace();
    const attachment = { name: 'a.txt', mime: 'text/plain', content: Buffer.from('a').toString('base64') };
    await materializeAttachments({ workspace: ws, workerRunId: 'turn-one', attachments: [attachment] });
    await materializeAttachments({ workspace: ws, workerRunId: 'turn-two', attachments: [attachment] });

    const exclude = await fs.readFile(path.join(ws, '.git', 'info', 'exclude'), 'utf8');
    const occurrences = exclude.split('\n').filter((l) => l === `/${ATTACHMENTS_DIR_NAME}/`).length;
    expect(occurrences).toBe(1);
    // Both turns' files coexist in per-run directories.
    await expect(fs.access(path.join(ws, ATTACHMENTS_DIR_NAME, 'turn-one', 'a.txt'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(ws, ATTACHMENTS_DIR_NAME, 'turn-two', 'a.txt'))).resolves.toBeUndefined();
  });

  it('returns [] and touches nothing for an empty attachment list', async () => {
    const ws = await makeGitWorkspace();
    expect(await materializeAttachments({ workspace: ws, workerRunId: 'r', attachments: [] })).toEqual([]);
    await expect(fs.access(path.join(ws, ATTACHMENTS_DIR_NAME))).rejects.toThrow();
  });
});

describe('appendAttachmentsToTask', () => {
  it('returns the task untouched when there are no attachments', () => {
    expect(appendAttachmentsToTask('do the thing', [])).toBe('do the thing');
  });

  it('appends the manifest with path, mime, and human-readable size', () => {
    const augmented = appendAttachmentsToTask('Fix the header per the mock', [
      { relPath: `${ATTACHMENTS_DIR_NAME}/run1/mock.png`, name: 'mock.png', mime: 'image/png', sizeBytes: 34_567 },
      { relPath: `${ATTACHMENTS_DIR_NAME}/run1/spec.pdf`, name: 'spec.pdf', mime: '', sizeBytes: 2 * 1024 * 1024 },
    ]);
    expect(augmented).toBe(
      [
        'Fix the header per the mock',
        '',
        'The user attached the following files with this task. They are inside the workspace at these paths:',
        `- ${ATTACHMENTS_DIR_NAME}/run1/mock.png (image/png, 33.8 KB)`,
        `- ${ATTACHMENTS_DIR_NAME}/run1/spec.pdf (unknown type, 2.0 MB)`,
        'Read them as needed to complete the task. They are reference material: do not commit, move, or delete them.',
      ].join('\n'),
    );
  });
});
