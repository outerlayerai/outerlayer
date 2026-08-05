#!/usr/bin/env node

/**
 * Parses Stryker's JSON report and emits the mutation score.
 *
 * Usage:
 *   node scripts/ci/extract-mutation-score.mjs <path-to-mutation.json> <workspace> [out-file]
 *
 * Writes a result record to stdout (and optionally to out-file). Appends a
 * markdown summary to GITHUB_STEP_SUMMARY when running in Actions.
 *
 * Score formula (matches Stryker's `thresholds.break` comparison —
 * `mutationScore`, not `mutationScoreBasedOnCoveredCode`):
 *   total    = killed + survived + timeout + noCoverage
 *   detected = killed + timeout
 *   score    = detected / total * 100
 *
 * NoCoverage mutants count against the score because Stryker's break gate
 * does too. Using the covered-only formula here makes the ratchet store
 * floors the gate can never satisfy.
 *
 * Mutants with status CompileError, RuntimeError, or Ignored are excluded
 * from the denominator, matching Stryker's convention.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const [, , reportPath, workspace = 'unknown', outFile] = process.argv;

if (!reportPath) {
  console.error('Usage: extract-mutation-score.mjs <mutation.json> <workspace> [out-file]');
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(`Report not found at ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));

let killed = 0;
let survived = 0;
let timeout = 0;
let noCoverage = 0;

for (const file of Object.values(report.files ?? {})) {
  for (const mutant of file.mutants ?? []) {
    switch (mutant.status) {
      case 'Killed': killed += 1; break;
      case 'Survived': survived += 1; break;
      case 'Timeout': timeout += 1; break;
      case 'NoCoverage': noCoverage += 1; break;
      default: break;
    }
  }
}

const total = killed + survived + timeout + noCoverage;
const detected = killed + timeout;
const score = total === 0 ? 0 : Number(((detected / total) * 100).toFixed(2));
const covered = killed + survived + timeout;
const coveredScore = covered === 0
  ? 0
  : Number(((detected / covered) * 100).toFixed(2));

const result = {
  workspace,
  score,
  coveredScore,
  killed,
  survived,
  timeout,
  noCoverage,
  total,
  timestamp: new Date().toISOString(),
};

console.log(JSON.stringify(result, null, 2));

if (outFile) {
  writeFileSync(outFile, JSON.stringify(result) + '\n');
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `## Stryker · \`${workspace}\``,
      '',
      `**Score: ${score}%** _(covered-only: ${coveredScore}%)_`,
      '',
      '| Killed | Survived | Timeout | No coverage | Total |',
      '|-------:|---------:|--------:|------------:|------:|',
      `| ${killed} | ${survived} | ${timeout} | ${noCoverage} | ${result.total} |`,
      '',
    ].join('\n') + '\n',
  );
}
