#!/usr/bin/env node

/**
 * Auto-ratchets `scripts/ci/mutation-score-floors.json` upward based on actual
 * mutation scores from a nightly Stryker run.
 *
 * Run modes:
 *   (default):  rewrites mutation-score-floors.json in place, prints a summary.
 *   --dry-run:  prints summary without writing.
 *
 * Meant to run after the nightly mutation workflow produces `score-<workspace>`
 * artifacts. The accompanying workflow diffs the file after this runs; if
 * anything changed, it opens a PR.
 *
 * This script NEVER lowers a floor. The Stryker `thresholds.break` in each
 * stryker.config.mjs handles the below-floor case as a build failure.
 *
 * Floor values in the JSON:
 *   - number  = break threshold for that workspace
 *   - null    = no break threshold set yet (first-run baseline)
 *
 * The bump POLICY is intentionally a single function — edit it to match your
 * team's taste for aggressiveness.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const floorsPath = path.join(cwd, 'scripts/ci/mutation-score-floors.json');
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const SCORES_DIR = process.env.SCORES_DIR ?? '/tmp/mutation-scores';

// ─────────────────────────────────────────────────────────────────────────────
// BUMP POLICY — your call. Edit this function, nothing else.
//
// Inputs:
//   currentScore: number  — actual mutation score from today's nightly run
//   currentFloor: number | null  — floor currently in the JSON (null = unset)
// Output:
//   number | null  — new floor. null means "still no floor, baseline pending".
//
// Defaults:
//   - If floor is null (first measurement ever): set to floor(current - 3).
//     Gives 3pt cushion so noise on the next run doesn't immediately fail.
//   - If floor exists: only bump when current exceeds floor + 3 (avoid churn
//     PRs on small noise). Bump to floor(current - 1) — small headroom.
// ─────────────────────────────────────────────────────────────────────────────
function computeBumpedFloor(currentScore, currentFloor) {
  const FIRST_SET_CUSHION = 3;
  const MIN_GAP_TO_BUMP = 3;
  const HEADROOM = 1;

  if (currentFloor === null || currentFloor === undefined) {
    // First measurement: establish a baseline below the observed score.
    return Math.max(0, Math.floor(currentScore - FIRST_SET_CUSHION));
  }
  const gap = currentScore - currentFloor;
  if (gap < MIN_GAP_TO_BUMP) return currentFloor;
  return Math.floor(currentScore - HEADROOM);
}

function readScoreFile(scoresDir, workspaceLabel) {
  // Workspace label is "apps/gateway"; artifact filename is score-<name>.json
  // where <name> is the basename.
  const name = workspaceLabel.split('/').pop();
  const file = path.join(scoresDir, `score-${name}.json`);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return typeof record.score === 'number' ? record.score : null;
  } catch {
    return null;
  }
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return typeof n === 'number' ? n.toFixed(2) : String(n);
}

function writeStepSummary(text) {
  if (!summaryPath) return;
  appendFileSync(summaryPath, text + '\n');
}

function main() {
  if (!existsSync(floorsPath)) {
    console.error(`mutation-score-floors.json not found at ${floorsPath}`);
    process.exit(1);
  }
  if (!existsSync(SCORES_DIR)) {
    console.error(`Scores directory not found: ${SCORES_DIR}`);
    console.error(`Set SCORES_DIR env var to the directory containing score-*.json files.`);
    process.exit(1);
  }

  const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
  const rows = [];
  const skipped = [];
  let changed = false;

  for (const label of Object.keys(floors).sort()) {
    const currentScore = readScoreFile(SCORES_DIR, label);
    const currentFloor = floors[label];
    if (currentScore === null) {
      skipped.push({ label, reason: 'no score artifact' });
      continue;
    }
    const bumped = computeBumpedFloor(currentScore, currentFloor);
    rows.push({ label, score: currentScore, before: currentFloor, after: bumped });
    if (bumped !== currentFloor) {
      floors[label] = bumped;
      changed = true;
    }
  }

  const lines = ['## Mutation Score Floor Ratchet', ''];
  if (rows.length === 0) {
    lines.push('_No workspace score files found._');
  } else {
    lines.push('| Workspace | Score | Floor (was) | Floor (now) | Δ |');
    lines.push('|---|---:|---:|---:|:--|');
    for (const r of rows) {
      const delta = r.before === r.after
        ? '—'
        : r.before === null
          ? '_first set_'
          : `+${(r.after - r.before).toFixed(2)}`;
      lines.push(`| ${r.label} | ${fmt(r.score)} | ${fmt(r.before)} | ${fmt(r.after)} | ${delta} |`);
    }
  }

  if (skipped.length > 0) {
    lines.push('', '### Skipped');
    for (const s of skipped) lines.push(`- ${s.label}: ${s.reason}`);
  }

  if (!changed) {
    lines.push('', '_No floor bumps. Scores have not improved enough to trigger._');
  }

  const rendered = lines.join('\n');
  console.log(rendered);
  writeStepSummary(rendered);

  if (changed && !dryRun) {
    writeFileSync(floorsPath, JSON.stringify(floors, null, 2) + '\n');
  }
}

main();
