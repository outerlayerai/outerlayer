import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';

/**
 * Gate: no NEW weak-only test assertions. The tenant-dashboard testing rules
 * (and root CLAUDE.md) ban these as the sole proof in a test — they pass for
 * almost any production code, so they're "fake-green":
 *
 *   .toBeDefined()              passes for any non-undefined value
 *   .toBeTruthy() / .toBeFalsy() a precise === would be stronger
 *   .toHaveBeenCalled()         proves it ran, not WHAT it ran with
 *   .not.toThrow()              too loose; assert the return value too
 *
 * The mutation gate only reaches changed files in Stryker-configured
 * workspaces, so weak assertions in unchanged code — or in workspaces with no
 * Stryker config (builder, most packages) — are never surfaced. This is the
 * backstop that reaches everywhere.
 *
 * ~1,266 of these exist today, so they're held against a FROZEN, count-based,
 * shrink-only baseline: a file may keep its grandfathered count, but adding a
 * weak assertion (count goes UP) fails, and removing one without re-baselining
 * (count goes DOWN, stale entry) also fails — forcing the debt strictly down.
 * Regenerate with --update-baseline. Negative assertions (`.not.toBeDefined()`,
 * `.not.toHaveBeenCalled()`) are NOT flagged — they express a real expectation.
 */

const ROOTS = ['apps', 'packages'];
const BASELINE_PATH = path.join(process.cwd(), 'scripts/weak-test-assertions.baseline.json');

// Positive weak matchers (a leading `.not` is excluded via lookbehind — those
// are meaningful negative assertions), plus the lone `.not.toThrow()`.
const PATTERNS = [
  /(?<!\.not)\.toBeDefined\(\s*\)/g,
  /(?<!\.not)\.toBeTruthy\(\s*\)/g,
  /(?<!\.not)\.toBeFalsy\(\s*\)/g,
  /(?<!\.not)\.toHaveBeenCalled\(\s*\)/g,
  /\.not\.toThrow\(\s*\)/g,
];

/** Count banned weak matchers in a source string, ignoring comment lines. */
export function countWeakAssertions(source) {
  let count = 0;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const re of PATTERNS) {
      const matches = rawLine.match(re);
      if (matches) count += matches.length;
    }
  }
  return count;
}

function scan() {
  const counts = {};
  for (const root of ROOTS) {
    const files = globSync(`${root}/*/**/*.{test,spec}.{ts,tsx}`, {
      cwd: process.cwd(),
      absolute: false,
      ignore: ['**/node_modules/**', '**/dist/**'],
    });
    for (const file of files) {
      const n = countWeakAssertions(readFileSync(file, 'utf8'));
      if (n > 0) counts[file] = n;
    }
  }
  return counts;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

const updateBaseline = process.argv.includes('--update-baseline');
const current = scan();

if (updateBaseline) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(
    `Wrote ${Object.keys(sorted).length} file(s) / ${total} weak assertion(s) to ` +
      `${path.relative(process.cwd(), BASELINE_PATH)}.`,
  );
  process.exit(0);
}

const baseline = loadBaseline();
const increased = []; // new or grown beyond grandfathered count
const stale = []; // improved (or deleted) but baseline not updated

for (const [file, n] of Object.entries(current)) {
  const allowed = baseline[file] ?? 0;
  if (n > allowed) increased.push({ file, n, allowed });
}
for (const [file, allowed] of Object.entries(baseline)) {
  const n = current[file] ?? 0;
  if (n < allowed) stale.push({ file, n, allowed });
}

const out = [];
if (increased.length > 0) {
  out.push(
    'New weak-only test assertions are not allowed (toBeDefined, toBeTruthy/toBeFalsy,',
    'bare toHaveBeenCalled, lone .not.toThrow). Use a concrete toEqual / toHaveBeenCalledWith.',
    '',
    ...increased.map((e) => `- ${e.file}: ${e.n} (allowed ${e.allowed})`),
  );
}
if (stale.length > 0) {
  out.push(
    '',
    'These files improved below their baseline — the baseline may only shrink.',
    'Run `node scripts/check-weak-test-assertions.mjs --update-baseline` to lock it in:',
    '',
    ...stale.map((e) => `- ${e.file}: now ${e.n} (baseline ${e.allowed})`),
  );
}

if (out.length > 0) {
  console.error(out.join('\n'));
  process.exit(1);
}
