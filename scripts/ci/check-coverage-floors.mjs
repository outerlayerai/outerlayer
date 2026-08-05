#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const roots = ['apps', 'packages'];
const floorsPath = path.join(cwd, 'scripts/ci/coverage-floors.json');

function workspaceDirs(root) {
  const resolved = path.join(cwd, root);
  if (!existsSync(resolved)) {
    return [];
  }

  return readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(resolved, entry.name));
}

function collectCoverage() {
  return roots
    .flatMap(workspaceDirs)
    .map((dir) => ({
      label: path.relative(cwd, dir),
      summaryFile: path.join(dir, 'coverage/coverage-summary.json'),
    }))
    .filter(({ summaryFile }) => existsSync(summaryFile))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatPct(value) {
  return `${value.toFixed(2)}%`;
}

const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const coverageDirs = collectCoverage();
const output = [];
const failures = [];

function append(line) {
  output.push(`${line}\n`);
}

append('## Coverage Floors');

for (const { label, summaryFile } of coverageDirs) {
  const totals = JSON.parse(readFileSync(summaryFile, 'utf8')).total;
  const floor = floors[label];

  if (!floor) {
    append(`- ${label}: no floor configured`);
    continue;
  }

  const metrics = ['statements', 'branches', 'functions', 'lines'];
  const deltas = [];

  for (const metric of metrics) {
    const actual = totals[metric].pct;
    const minimum = floor[metric];
    const delta = Number((actual - minimum).toFixed(2));
    deltas.push(`${metric} ${formatPct(actual)} vs ${formatPct(minimum)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%)`);

    if (actual < minimum) {
      failures.push(`${label}: ${metric} ${formatPct(actual)} is below floor ${formatPct(minimum)}`);
    }
  }

  append(`- ${label}: ${deltas.join(', ')}`);
}

const rendered = output.join('');
process.stdout.write(rendered);

if (summaryPath) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summaryPath, rendered);
}

if (failures.length > 0) {
  console.error('\nCoverage floor failures:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
