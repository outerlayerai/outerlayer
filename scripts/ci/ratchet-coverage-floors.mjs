#!/usr/bin/env node

/**
 * Auto-ratchets `scripts/ci/coverage-floors.json` upward based on actual coverage
 * from the latest test:coverage run.
 *
 * Run modes:
 *   (default): rewrites coverage-floors.json in place, prints a summary.
 *   --dry-run: prints summary without writing.
 *
 * Meant to run on `main` push (NOT per-PR). The accompanying workflow compares
 * git diff after this runs; if anything changed, it opens a PR with the bump.
 *
 * This script NEVER lowers a floor. If actual coverage is below the existing
 * floor, `check-coverage-floors.mjs` handles that as a failure.
 *
 * The bump POLICY is intentionally a single function — edit it to match your
 * team's taste for aggressiveness. Any change to the policy only affects the
 * next main-push run; no migration needed.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const floorsPath = path.join(cwd, 'scripts/ci/coverage-floors.json');
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

const METRICS = ['statements', 'branches', 'functions', 'lines'];

// ─────────────────────────────────────────────────────────────────────────────
// BUMP POLICY — your call. Edit this function, nothing else.
//
// Inputs:
//   current: { statements, branches, functions, lines } — actual pct from lcov
//   floor:   { statements, branches, functions, lines } — currently committed
// Output:
//   { statements, branches, functions, lines } — new floor values
//
// Defaults below: bump to (current - 2), only if the gap is at least 3 pct.
// 2pp headroom absorbs normal PR-level swing on small-base workspaces — e.g.
// apps/builder has ~315 branches, so 1pp headroom = 3 branches and a single
// PR can plausibly miss that many new branches. 2pp = 6 branches of buffer.
// 3pp gap-to-bump prevents churn PRs for noise while still ratcheting on
// sustained improvement.
//
// Other reasonable policies you might swap in:
//   - Half-the-gain:   new = floor + (current - floor) / 2  (climbs slower)
//   - Round-down:      new = Math.floor(current)            (more aggressive)
//   - Per-metric:      different policy for branches vs lines
// ─────────────────────────────────────────────────────────────────────────────
function computeBumpedFloor(current, floor) {
  const MIN_GAP_TO_BUMP = 3;
  const HEADROOM = 2;
  const result = {};
  for (const metric of METRICS) {
    const gap = current[metric] - floor[metric];
    if (gap >= MIN_GAP_TO_BUMP) {
      result[metric] = Math.floor((current[metric] - HEADROOM) * 10) / 10;
    } else {
      result[metric] = floor[metric];
    }
  }
  return result;
}

function readCurrent(workspaceLabel) {
  const summaryFile = path.join(cwd, workspaceLabel, 'coverage/coverage-summary.json');
  if (!existsSync(summaryFile)) return null;
  const totals = JSON.parse(readFileSync(summaryFile, 'utf8')).total;
  return {
    statements: totals.statements.pct,
    branches: totals.branches.pct,
    functions: totals.functions.pct,
    lines: totals.lines.pct,
  };
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : String(n);
}

function writeStepSummary(text) {
  if (!summaryPath) return;
  appendFileSync(summaryPath, text + '\n');
}

function main() {
  if (!existsSync(floorsPath)) {
    console.error(`coverage-floors.json not found at ${floorsPath}`);
    process.exit(1);
  }

  const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
  const proposals = [];
  const skipped = [];

  for (const label of Object.keys(floors).sort()) {
    const current = readCurrent(label);
    const floor = floors[label];
    if (!current) {
      skipped.push({ label, reason: 'no coverage data' });
      continue;
    }
    const bumped = computeBumpedFloor(current, floor);
    proposals.push({ label, current, floor, bumped });
  }

  const lines = ['## Coverage Floor Ratchet', ''];
  let changed = false;

  for (const p of proposals) {
    const deltas = METRICS
      .map((m) => {
        const before = p.floor[m];
        const after = p.bumped[m];
        if (before === after) return null;
        return `${m} ${fmt(before)} → ${fmt(after)}`;
      })
      .filter(Boolean);
    if (deltas.length > 0) {
      lines.push(`- **${p.label}**: ${deltas.join(', ')}`);
      floors[p.label] = p.bumped;
      changed = true;
    }
  }

  if (!changed) {
    lines.push('No floors changed. Coverage hasn\'t moved enough to trigger a bump.');
  }

  if (skipped.length > 0) {
    lines.push('', '### Skipped');
    for (const s of skipped) lines.push(`- ${s.label}: ${s.reason}`);
  }

  const rendered = lines.join('\n');
  console.log(rendered);
  writeStepSummary(rendered);

  if (changed && !dryRun) {
    writeFileSync(floorsPath, JSON.stringify(floors, null, 2) + '\n');
  }
}

main();
