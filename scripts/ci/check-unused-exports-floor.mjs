#!/usr/bin/env node
/**
 * Two-way floor for knip's `exports` / `types` detectors.
 *
 * WHY THIS EXISTS SEPARATELY FROM `ci:knip`.
 *   `knip.json` keeps `exports` / `types` / `nsExports` / `nsTypes` at "off":
 *   turning them on in the main run floods CI with hundreds of false positives
 *   (intentional public API, OSS package entry exports, test-utility modules,
 *   barrel re-exports) mixed with genuine dead code. Taming every one of those
 *   is a monorepo-wide config audit, not a rule flip — so the main `ci:knip`
 *   run can't enforce these detectors yet.
 *
 *   This script activates them SAFELY instead: it runs knip with the detectors
 *   ON, counts the unused exports + types per workspace bucket, and fails in
 *   BOTH directions: a bucket above its floor means new dead exports were
 *   introduced; a bucket below its floor means dead code was removed without
 *   committing the tighter floor (run `--update`). The floors file is an
 *   exact ledger of tolerated exceptions, never a stale high-water mark.
 *
 * USAGE
 *   node scripts/ci/check-unused-exports-floor.mjs            # check (CI)
 *   node scripts/ci/check-unused-exports-floor.mjs --update   # rebaseline
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const floorsPath = path.join(cwd, 'scripts/ci/unused-exports-floors.json');
const update = process.argv.includes('--update');

/**
 * Bucket a repo-relative file path to a workspace key: the first two path
 * segments (`apps/tenant-dashboard`, `packages/gateway-core`). Anything
 * shallower falls back to its first segment. This is the same grouping the
 * floors file is keyed by, so a regression is localized to one bucket and
 * can't be masked by removing dead code elsewhere.
 */
function bucketOf(file) {
  const parts = file.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Run knip with the export/type detectors forced on; return its JSON report. */
function runKnip() {
  // Derive a temp config from knip.json with the detectors flipped on, so the
  // workspace/entry/ignore setup stays single-sourced (no drift).
  const knipConfig = JSON.parse(readFileSync(path.join(cwd, 'knip.json'), 'utf8'));
  for (const rule of ['exports', 'types', 'nsExports', 'nsTypes']) {
    knipConfig.rules[rule] = 'warn';
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'knip-exports-floor-'));
  const tmpConfig = path.join(dir, 'knip.json');
  writeFileSync(tmpConfig, JSON.stringify(knipConfig));

  try {
    // knip exits non-zero whenever it reports issues (it always will here), so
    // the JSON we want is on stdout of the thrown error too.
    let raw;
    try {
      raw = execSync(
        `npx knip -c "${tmpConfig}" --include exports,types,nsExports,nsTypes --no-config-hints --reporter json`,
        { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
      );
    } catch (err) {
      raw = err.stdout;
    }
    if (!raw || !raw.trim()) {
      throw new Error('knip produced no JSON output — cannot compute the unused-exports floor.');
    }
    return JSON.parse(raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Count unused exports + types per workspace bucket from the knip report. */
function countByBucket(report) {
  const counts = {};
  for (const issue of report.issues ?? []) {
    const n =
      (issue.exports?.length ?? 0) +
      (issue.types?.length ?? 0) +
      (issue.nsExports?.length ?? 0) +
      (issue.nsTypes?.length ?? 0);
    if (n === 0) continue;
    const bucket = bucketOf(issue.file);
    counts[bucket] = (counts[bucket] ?? 0) + n;
  }
  return counts;
}

const counts = countByBucket(runKnip());

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(floorsPath, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(`Wrote ${floorsPath} — ${Object.keys(sorted).length} buckets, ${total} unused exports/types.`);
  process.exit(0);
}

const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const output = ['## Unused Exports Floor (knip exports + types)\n'];
const failures = [];
const stale = [];

// Any bucket present in the report OR the floors is checked. A NEW bucket
// (not in floors) has an implicit floor of 0, so dead code in a fresh package
// fails until it's explicitly baselined — deliberate.
const buckets = [...new Set([...Object.keys(floors), ...Object.keys(counts)])].sort();
for (const bucket of buckets) {
  const actual = counts[bucket] ?? 0;
  const floor = floors[bucket] ?? 0;
  const delta = actual - floor;
  output.push(`- ${bucket}: ${actual} vs ${floor} (${delta > 0 ? '+' : ''}${delta})\n`);
  if (actual > floor) {
    failures.push(`${bucket}: ${actual} unused exports/types exceeds floor ${floor} (+${delta})`);
  } else if (actual < floor) {
    stale.push(`${bucket}: ${actual} vs committed floor ${floor} (${delta})`);
  }
}

const rendered = output.join('');
process.stdout.write(rendered);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered);
}

if (failures.length > 0) {
  console.error('\nUnused-exports floor exceeded — new dead export(s) or type(s) introduced:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    '\nFind them with:\n' +
      '  npx knip --include exports,types --no-config-hints  (with exports/types rules on)\n' +
      'Then delete the unused export, or — if you legitimately REDUCED dead code — ' +
      'rebaseline with:\n' +
      '  node scripts/ci/check-unused-exports-floor.mjs --update',
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error('\nUnused-exports floor is stale — dead code was removed without tightening the floor:');
  for (const entry of stale) console.error(`- ${entry}`);
  console.error('\nCommit the tighter floor:\n  node scripts/ci/check-unused-exports-floor.mjs --update');
  process.exit(1);
}
