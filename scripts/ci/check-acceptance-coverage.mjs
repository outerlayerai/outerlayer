#!/usr/bin/env node
/**
 * Binds a spec's acceptance criteria to the tests that prove them.
 *
 * WHY THIS EXISTS.
 *   Every other gate in this repo answers "does the code do what the code
 *   says?" — coverage, mutation score, tenancy scans, type-suppression floors.
 *   None of them answers "did we build the thing that was asked for?" A feature
 *   can hold a 90% mutation score, zero unscoped queries, and still implement
 *   the wrong behaviour, because the tests were written by reading the
 *   implementation rather than the criteria.
 *
 *   This gate closes that loop WITHOUT a BDD framework. Acceptance scenarios in
 *   `acceptance/<n>-<slug>.md` carry a stable id (`AC-056-03`); the tests that
 *   prove them cite the same id in a title or comment. The gate then enforces
 *   the join in both directions, so a criterion cannot quietly go unproven and
 *   a test cannot cite a criterion that no longer exists.
 *
 * WHY `acceptance/` IS ITS OWN TRACKED DIRECTORY.
 *   Planning scratch is local-only and disposable, so a gate reading it would
 *   pass vacuously in CI — the files simply aren't there. Criteria that gate
 *   the build have to be committed, reviewable, and diffable on their own.
 *   Extracting them also makes the contract outlive the scratchpad it came
 *   from. A feature's criteria land here when implementation starts.
 *
 * WHY IDS ARE WRITTEN, NOT DERIVED FROM POSITION.
 *   A positional id (story 1, scenario 3) silently re-points at a different
 *   criterion the moment someone inserts or reorders a scenario — and the test
 *   still passes, now proving the wrong thing. Written ids survive reordering.
 *
 * THE FOUR HARD CHECKS (no floor — these always fail the build):
 *   1. MISMATCH  — `AC-044-01` declared inside `acceptance/056-…` (copy-paste
 *                  across features, which would make the id ambiguous).
 *   2. DUPLICATE — the same id declared on two scenarios.
 *   3. UNBOUND   — a declared id no test cites. Writing an id IS the assertion
 *                  that the criterion is provable, so this needs no opt-in:
 *                  don't label a scenario until you're implementing it.
 *   4. ORPHAN    — a test cites an id no criteria file declares (typo, or a
 *                  criterion deleted out from under a test still claiming it).
 *
 * THE RATCHET (`acceptance-coverage-floors.json`):
 *   Per file, the count of acceptance scenarios still carrying NO id — the
 *   unproven-criteria debt, for a feature whose criteria are extracted ahead of
 *   its implementation. Shrink-only, like every other floor here. A file ABSENT
 *   from the floors file is ungated, so criteria can be drafted without
 *   reddening CI the day they land. Baseline with `--update`, then ratchet to
 *   zero as criteria get proven.
 *
 * USAGE
 *   node scripts/ci/check-acceptance-coverage.mjs            # check (CI)
 *   node scripts/ci/check-acceptance-coverage.mjs --update   # rebaseline
 */

import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const cwd = process.env.ACCEPTANCE_COVERAGE_CWD ?? process.cwd();
const floorsPath = path.join(cwd, 'scripts/ci/acceptance-coverage-floors.json');
const update = process.argv.includes('--update');

/** `AC-<spec>-<seq>` — spec number is 3 digits to match the `acceptance/NNN-slug.md` files. */
const AC_ID = /\bAC-(\d{3})-(\d{2})\b/g;

/**
 * Directories that can never hold a first-party test, but are large enough that
 * walking them dominates runtime. Two entries are correctness, not speed:
 * `.claude` (parallel worktrees carry their own full checkout, and counting
 * their copy of a test would let a stale worktree satisfy a binding) and
 * `specs` (local-only planning scratch, absent in CI — a binding satisfied
 * there would pass locally and fail on the runner).
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  '.yarn',
  'reports',
  '.claude',
  'specs',
]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Recursively collect files under `dir` matching `predicate`, skipping SKIP_DIRS. */
function walk(dir, predicate, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, predicate, found);
    } else if (predicate(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A Gherkin acceptance scenario as this repo writes them: a numbered list item
 * carrying both a Given and a Then. Requiring BOTH keeps ordinary numbered
 * prose in a spec from being miscounted as criteria debt.
 */
function isScenarioLine(line) {
  return /^\s*\d+\.\s/.test(line) && line.includes('**Given**') && line.includes('**Then**');
}

/** Every `acceptance/NNN-slug.md`, keyed by its 3-digit feature number. */
function readCriteriaFiles() {
  const root = path.join(cwd, 'acceptance');
  const files = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const number = /^(\d{3})-.*\.md$/.exec(entry.name)?.[1];
    if (!number) continue;
    const file = path.join(root, entry.name);
    files.push({
      name: entry.name.replace(/\.md$/, ''),
      number,
      file,
      lines: readFileSync(file, 'utf8').split('\n'),
    });
  }
  return files;
}

const criteriaFiles = readCriteriaFiles();

/** id -> {file, line}; plus per-file scenario tallies. */
const declared = new Map();
const perFile = new Map();
const mismatches = [];
const duplicates = [];

for (const criteria of criteriaFiles) {
  let total = 0;
  let unlabeled = 0;

  criteria.lines.forEach((line, index) => {
    if (!isScenarioLine(line)) return;
    total += 1;

    const ids = [...line.matchAll(AC_ID)];
    if (ids.length === 0) {
      unlabeled += 1;
      return;
    }

    for (const match of ids) {
      const [id, featureNumber] = match;
      const at = `acceptance/${criteria.name}.md:${index + 1}`;
      if (featureNumber !== criteria.number) {
        mismatches.push(`${at} declares ${id}, but this file is ${criteria.number}`);
        continue;
      }
      const prior = declared.get(id);
      if (prior) {
        duplicates.push(`${id} declared twice — acceptance/${prior.file}.md:${prior.line} and ${at}`);
        continue;
      }
      declared.set(id, { file: criteria.name, line: index + 1 });
    }
  });

  perFile.set(criteria.name, { total, unlabeled });
}

/** id -> Set of repo-relative test files citing it. */
const cited = new Map();
for (const file of walk(cwd, (name) => TEST_FILE.test(name))) {
  const relative = path.relative(cwd, file);
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const match of contents.matchAll(AC_ID)) {
    const id = match[0];
    if (!cited.has(id)) cited.set(id, new Set());
    cited.get(id).add(relative);
  }
}

if (update) {
  const sorted = Object.fromEntries(
    [...perFile.entries()]
      .filter(([, counts]) => counts.total > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counts]) => [name, counts.unlabeled]),
  );
  writeFileSync(floorsPath, `${JSON.stringify(sorted, null, 2)}\n`);
  const debt = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(
    `Wrote ${floorsPath} — ${Object.keys(sorted).length} features, ${declared.size} bound criteria, ${debt} still unlabeled.`,
  );
  process.exit(0);
}

let floors = {};
try {
  floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
} catch {
  console.error(
    `Missing or unreadable ${floorsPath}.\nCreate it with: node scripts/ci/check-acceptance-coverage.mjs --update`,
  );
  process.exit(1);
}

const unbound = [...declared.entries()]
  .filter(([id]) => !cited.has(id))
  .map(([id, where]) => `${id} (acceptance/${where.file}.md:${where.line}) is proven by no test`);

const orphans = [...cited.entries()]
  .filter(([id]) => !declared.has(id))
  .map(([id, files]) => `${id} is cited by ${[...files].join(', ')} but no criteria file declares it`);

const output = ['## Acceptance Criteria Coverage\n'];
const floorFailures = [];
for (const name of Object.keys(floors).sort()) {
  const counts = perFile.get(name);
  if (!counts) {
    // A baselined feature whose criteria file vanished or was renamed: the
    // floor is now unenforceable and would silently pass forever. Fail loudly.
    floorFailures.push(
      `${name}: baselined in the floors file but acceptance/${name}.md is missing — remove the entry or restore the file`,
    );
    continue;
  }
  const floor = floors[name];
  const bound = counts.total - counts.unlabeled;
  const delta = counts.unlabeled - floor;
  output.push(`- ${name}: ${bound}/${counts.total} criteria bound, ${counts.unlabeled} unlabeled vs floor ${floor} (${delta > 0 ? '+' : ''}${delta})\n`);
  if (counts.unlabeled > floor) {
    floorFailures.push(`${name}: ${counts.unlabeled} unlabeled criteria exceeds floor ${floor} (+${delta})`);
  }
}

const rendered = output.join('');
process.stdout.write(rendered);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered);
}

const sections = [
  ['Acceptance criteria whose id does not match the file that declares them', mismatches],
  ['Duplicate acceptance-criteria ids', duplicates],
  ['Acceptance criteria with no test proving them', unbound],
  ['Tests citing an acceptance criterion that no criteria file declares', orphans],
  ['Unlabeled-criteria floor exceeded', floorFailures],
];

const failed = sections.filter(([, items]) => items.length > 0);
if (failed.length > 0) {
  for (const [heading, items] of failed) {
    console.error(`\n${heading}:`);
    for (const item of items) console.error(`- ${item}`);
  }
  console.error(
    '\nBind a criterion by citing its id in a comment above the test that proves it:\n' +
      '  // proves AC-056-03\n' +
      "  it('truncates an oversize trace to the token cap', …)\n" +
      'If you legitimately REDUCED the number of unlabeled criteria, rebaseline with:\n' +
      '  node scripts/ci/check-acceptance-coverage.mjs --update',
  );
  process.exit(1);
}

console.log(`\nAll ${declared.size} labeled acceptance criteria are bound to a test.`);
