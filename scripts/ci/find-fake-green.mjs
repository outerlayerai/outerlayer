#!/usr/bin/env node

/**
 * Fake-green test finder.
 *
 * Surfaces files whose code IS exercised by tests but whose mutants SURVIVE —
 * i.e. the test runs the code and asserts almost nothing (the storage-metering
 * 0%-mutation incident). This is DISTINCT from "untested" code: a `NoCoverage`
 * mutant means no test touches the line (a coverage gap that coverage % already
 * catches); a `Survived` mutant means a test touches it but wouldn't catch a
 * bug there. We rank by the score AMONG COVERED mutants, so a file with a real
 * test that asserts nothing rises to the top while a merely-undertested file
 * (mostly NoCoverage) does not.
 *
 * Data source: Stryker JSON reports (`reports/mutation/mutation.json`), which
 * the nightly already produces per workspace/shard. Point this at those.
 *
 * Usage:
 *   node scripts/ci/find-fake-green.mjs <mutation.json | dir> [...more]
 *
 * Env knobs:
 *   FAKE_GREEN_SCORE        flag files whose covered-mutant kill rate is below
 *                           this % (default 50)
 *   FAKE_GREEN_MIN_COVERED  ignore files with fewer covered mutants than this —
 *                           too small to judge (default 5)
 *
 * Exit 0 always (this is a report, not a gate — strengthening is a human call).
 */

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const SCORE_FLOOR = Number(process.env.FAKE_GREEN_SCORE ?? 50);
const MIN_COVERED = Number(process.env.FAKE_GREEN_MIN_COVERED ?? 5);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function collectReports(args) {
  const reports = [];
  const visit = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) {
      // Common locations: <p>/reports/mutation/mutation.json, or any nested one.
      const direct = path.join(p, 'reports/mutation/mutation.json');
      if (existsSync(direct)) reports.push(direct);
      for (const name of readdirSync(p)) {
        if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
        const child = path.join(p, name);
        if (existsSync(child) && statSync(child).isDirectory()) visit(child);
        else if (name === 'mutation.json') reports.push(child);
      }
    } else if (p.endsWith('.json')) {
      reports.push(p);
    }
  };
  for (const a of args) visit(a);
  return [...new Set(reports)];
}

function analyze(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const rows = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    let killed = 0;
    let survived = 0;
    let timeout = 0;
    let noCoverage = 0;
    for (const m of data.mutants ?? []) {
      switch (m.status) {
        case 'Killed': killed += 1; break;
        case 'Survived': survived += 1; break;
        case 'Timeout': timeout += 1; break;
        case 'NoCoverage': noCoverage += 1; break;
        default: break;
      }
    }
    const covered = killed + survived + timeout;
    if (covered < MIN_COVERED) continue; // not enough signal
    const coveredScore = ((killed + timeout) / covered) * 100;
    if (coveredScore >= SCORE_FLOOR) continue; // tests here actually catch bugs
    rows.push({ file, coveredScore, survived, covered, noCoverage });
  }
  return rows;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: find-fake-green.mjs <mutation.json | dir> [...]');
  process.exit(2);
}

const reports = collectReports(args);
const rows = reports.flatMap(analyze);
// Worst first: lowest kill-rate, then most surviving covered mutants.
rows.sort((a, b) => a.coveredScore - b.coveredScore || b.survived - a.survived);

const out = ['## Fake-green test suspects', ''];
if (reports.length === 0) {
  out.push('_No Stryker mutation.json reports found in the given path(s)._');
} else if (rows.length === 0) {
  out.push(
    `Scanned ${reports.length} report(s): no covered files below ${SCORE_FLOOR}% kill rate. ` +
      'Either the tested code asserts well, or coverage is the gap (check NoCoverage separately).',
  );
} else {
  out.push(
    `Files whose tests RUN the code but kill <${SCORE_FLOOR}% of covered mutants — ` +
      'i.e. the tests assert too little. Strengthen these (or the test is fake-green):',
    '',
    '| File | Kill rate (covered) | Surviving covered mutants | Untested mutants |',
    '|---|---:|---:|---:|',
  );
  for (const r of rows) {
    const f = r.file.replace(`${process.cwd()}/`, '');
    out.push(`| \`${f}\` | ${r.coveredScore.toFixed(1)}% | ${r.survived} | ${r.noCoverage} |`);
  }
  out.push('', `**${rows.length}** suspect file(s). A 0% kill-rate row with many surviving mutants is the storage-metering pattern — the test runs everything and asserts nothing.`);
}

const text = `${out.join('\n')}\n`;
process.stdout.write(text);
if (summaryPath) {
  try {
    appendFileSync(summaryPath, text);
  } catch {
    /* best-effort */
  }
}
