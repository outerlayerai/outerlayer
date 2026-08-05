/**
 * Materializes user-uploaded attachments into the workspace so
 * the agent can read them. Files land under
 * `<workspace>/.outerlayer-attachments/<run8>/` — a directory git-excluded via
 * `.git/info/exclude`, so attachments never appear in the collected diff, the
 * turn checkpoint commit, or the resulting PR. The exclude is repo-local (not
 * .gitignore) so it can't collide with tracked tenant files, and the
 * deliberately unusual directory name keeps clear of any `.outerlayer/` config
 * a tenant repo may track.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkerAttachment } from '../lib/schemas.js';

export const ATTACHMENTS_DIR_NAME = '.outerlayer-attachments';

export interface MaterializedAttachment {
  /** Workspace-relative path the prompt references, e.g. `.outerlayer-attachments/ab12cd34/logo.png`. */
  relPath: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

/**
 * Reduce an arbitrary client-supplied file name to a single safe path
 * component: no directories, no traversal, no control or shell-hostile
 * characters, bounded length, never empty or dot-only.
 */
export function sanitizeAttachmentFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '');
  const bounded = cleaned.length > 80 ? cleaned.slice(-80).replace(/^[.-]+/, '') : cleaned;
  return bounded.length > 0 ? bounded : 'attachment';
}

/** Ensure the attachments dir is ignored by every git status/add in this clone. */
async function excludeFromGit(workspace: string): Promise<void> {
  const infoDir = path.join(workspace, '.git', 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  const line = `/${ATTACHMENTS_DIR_NAME}/`;
  await fs.mkdir(infoDir, { recursive: true });
  const existing = await fs.readFile(excludeFile, 'utf8').catch(() => '');
  if (existing.split('\n').includes(line)) return;
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.appendFile(excludeFile, `${separator}${line}\n`, 'utf8');
}

/**
 * Write the run's attachments into the workspace and git-exclude them.
 * Name collisions (after sanitizing) get a numeric suffix before the
 * extension so every attachment survives. Returns the materialized list in
 * input order for the prompt suffix.
 */
export async function materializeAttachments(opts: {
  workspace: string;
  workerRunId: string;
  attachments: WorkerAttachment[];
}): Promise<MaterializedAttachment[]> {
  if (opts.attachments.length === 0) return [];

  await excludeFromGit(opts.workspace);

  // Per-run subdirectory: persistent workspaces host many turns, and this
  // keeps one turn's files from silently overwriting another's.
  const runDirRel = path.join(ATTACHMENTS_DIR_NAME, opts.workerRunId.slice(0, 8));
  const runDirAbs = path.join(opts.workspace, runDirRel);
  await fs.mkdir(runDirAbs, { recursive: true });

  const used = new Set<string>();
  const materialized: MaterializedAttachment[] = [];
  for (const attachment of opts.attachments) {
    const safe = sanitizeAttachmentFileName(attachment.name);
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let candidate = safe;
    for (let n = 1; used.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
    used.add(candidate);

    const abs = path.resolve(runDirAbs, candidate);
    if (!abs.startsWith(path.resolve(runDirAbs) + path.sep)) {
      // Unreachable after sanitizing; a hard stop in case that ever regresses.
      throw new Error(`attachment path escapes the attachments directory: ${attachment.name}`);
    }
    const bytes = Buffer.from(attachment.content, 'base64');
    await fs.writeFile(abs, bytes);
    materialized.push({
      relPath: path.posix.join(runDirRel.split(path.sep).join('/'), candidate),
      name: attachment.name,
      mime: attachment.mime,
      sizeBytes: bytes.byteLength,
    });
  }
  return materialized;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Append the attachment manifest to the task prompt so the agent knows the
 * files exist and where they are. The instruction to leave them untouched
 * keeps a well-behaved agent from committing or "cleaning up" the directory
 * (defense in depth — git excludes them regardless).
 */
export function appendAttachmentsToTask(
  task: string,
  materialized: MaterializedAttachment[],
): string {
  if (materialized.length === 0) return task;
  const lines = materialized.map(
    (m) => `- ${m.relPath} (${m.mime || 'unknown type'}, ${formatSize(m.sizeBytes)})`,
  );
  return [
    task,
    '',
    'The user attached the following files with this task. They are inside the workspace at these paths:',
    ...lines,
    'Read them as needed to complete the task. They are reference material: do not commit, move, or delete them.',
  ].join('\n');
}
