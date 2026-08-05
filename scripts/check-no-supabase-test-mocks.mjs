import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import {
  isBannedSupabaseTestMockSpecifier,
  detectStructuralSupabaseMocks,
} from '../packages/eslint-config/supabase-test-mocks-shared.mjs';
import { WORKSPACES } from './no-supabase-test-mocks.config.mjs';

/**
 * Gate: no NEW Supabase mocks in tests. Three banned shapes (see the
 * tenant-dashboard testing rules):
 *
 *   1. vi.mock('<supabase specifier>')        — strict, no grandfathering.
 *   2. vi.spyOn(<m>, 'createSupabase*Client') — structural, baselined.
 *   3. hand-rolled from()/select()/eq() fake  — structural, baselined.
 *
 * (1) was already enforced, so there is no existing debt to grandfather — it
 * stays a hard fail. (2) and (3) are newly detected and have ~46 pre-existing
 * occurrences, so they are gated against a FROZEN baseline that may only
 * SHRINK: a file already in the baseline is tolerated; a NEW offender fails;
 * and a baseline entry that no longer offends (fixed or deleted) ALSO fails,
 * forcing the baseline down as debt is paid. Regenerate with --update-baseline.
 */

const BASELINE_PATH = path.join(
  process.cwd(),
  'scripts/no-supabase-test-mocks.baseline.json',
);

const cliArgs = process.argv.slice(2);
const updateBaseline = cliArgs.includes('--update-baseline');
const workspaceArgs = cliArgs.filter((arg) => !arg.startsWith('--'));
const requestedWorkspaces =
  workspaceArgs.length === 0 || cliArgs.includes('--all')
    ? Object.keys(WORKSPACES)
    : workspaceArgs;

const unknownWorkspaces = requestedWorkspaces.filter((name) => !WORKSPACES[name]);
if (unknownWorkspaces.length > 0) {
  console.error(
    `Usage: node scripts/check-no-supabase-test-mocks.mjs [--all|<workspace> ...] [--update-baseline]\n` +
      `Known workspaces: ${Object.keys(WORKSPACES).join(', ')}`,
  );
  process.exit(1);
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return [];
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? [];
}

/** Scan the requested workspaces. Returns repo-relative offender paths. */
function scan(workspaces) {
  const viMockOffenders = [];
  const structuralOffenders = new Map(); // relPath -> kinds[]

  for (const workspaceName of workspaces) {
    const config = WORKSPACES[workspaceName];
    const files = globSync('**/*.{test,spec}.{ts,tsx,js,jsx}', {
      cwd: config.root,
      absolute: true,
    });

    for (const file of files) {
      const relativePath = path.relative(process.cwd(), file);
      const source = readFileSync(file, 'utf8');

      for (const [, specifier] of source.matchAll(/vi\.mock\(\s*['"]([^'"]+)['"]/g)) {
        if (isBannedSupabaseTestMockSpecifier(specifier)) {
          viMockOffenders.push({ file: relativePath, workspace: workspaceName });
          break;
        }
      }

      const kinds = detectStructuralSupabaseMocks(source);
      if (kinds.length > 0) structuralOffenders.set(relativePath, kinds);
    }
  }

  return { viMockOffenders, structuralOffenders };
}

// --update-baseline: snapshot the current structural offenders and exit.
if (updateBaseline) {
  // Always regenerate from a full scan so the baseline is complete regardless
  // of which workspaces were passed.
  const { structuralOffenders } = scan(Object.keys(WORKSPACES));
  const files = [...structuralOffenders.keys()].sort();
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(
    `Wrote ${files.length} file(s) to ${path.relative(process.cwd(), BASELINE_PATH)}.`,
  );
  process.exit(0);
}

const { viMockOffenders, structuralOffenders } = scan(requestedWorkspaces);
const baseline = new Set(loadBaseline());

// Only hold baseline entries that belong to a scanned workspace accountable for
// staleness — a single-workspace run must not flag another workspace's debt.
const scannedRoots = requestedWorkspaces.map((name) => WORKSPACES[name].root);
const inScannedScope = (relPath) =>
  scannedRoots.some((root) => relPath.startsWith(`${root}/`));

const newStructural = [...structuralOffenders.keys()]
  .filter((file) => !baseline.has(file))
  .sort();

const staleBaseline = [...baseline]
  .filter((file) => inScannedScope(file) && !structuralOffenders.has(file))
  .sort();

const reports = [];

// (1) vi.mock specifier bans — strict, grouped by workspace message.
const viMockByWorkspace = new Map();
for (const { file, workspace } of viMockOffenders) {
  if (!viMockByWorkspace.has(workspace)) viMockByWorkspace.set(workspace, []);
  viMockByWorkspace.get(workspace).push(file);
}
for (const [workspace, files] of viMockByWorkspace) {
  reports.push(
    [WORKSPACES[workspace].message, '', ...files.map((f) => `- ${f}`)].join('\n'),
  );
}

// (2)+(3) new structural offenders — not in the frozen baseline.
if (newStructural.length > 0) {
  reports.push(
    [
      'New structure-aware Supabase test mocks are not allowed (vi.spyOn on a',
      'createSupabase*Client factory, or a hand-rolled from()/select()/eq() fake).',
      'Use shared MSW handlers under src/test-helpers/msw-handlers/ instead.',
      '',
      ...newStructural.map((f) => `- ${f} [${structuralOffenders.get(f).join(', ')}]`),
    ].join('\n'),
  );
}

// Shrink-only ratchet: a baseline entry that no longer offends must be removed.
if (staleBaseline.length > 0) {
  reports.push(
    [
      'These files are in the Supabase-mock baseline but no longer match — the',
      'baseline may only shrink. Run `node scripts/check-no-supabase-test-mocks.mjs',
      '--update-baseline` to remove them and lock in the progress:',
      '',
      ...staleBaseline.map((f) => `- ${f}`),
    ].join('\n'),
  );
}

if (reports.length > 0) {
  console.error(reports.join('\n\n'));
  process.exit(1);
}
