#!/usr/bin/env node

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const roots = ['apps', 'packages'];

const output = [];

function append(line) {
  output.push(`${line}\n`);
}

function workspaceDirs(root) {
  const resolved = path.join(cwd, root);
  if (!existsSync(resolved)) {
    return [];
  }

  return readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(resolved, entry.name));
}

const coverageDirs = roots
  .flatMap(workspaceDirs)
  .map((dir) => ({
    label: path.relative(cwd, dir),
    summaryFile: path.join(dir, 'coverage/coverage-summary.json'),
  }))
  .filter(({ summaryFile }) => existsSync(summaryFile))
  .sort((a, b) => a.label.localeCompare(b.label));

if (coverageDirs.length === 0) {
  append('No coverage summaries found.');
} else {
  append('## Unit Test Coverage Summary');

  for (const { label, summaryFile } of coverageDirs) {
    const totals = JSON.parse(readFileSync(summaryFile, 'utf8')).total;
    append(`### ${label}`);
    append('```');
    append(`Statements: ${totals.statements.pct}%`);
    append(`Branches:   ${totals.branches.pct}%`);
    append(`Functions:  ${totals.functions.pct}%`);
    append(`Lines:      ${totals.lines.pct}%`);
    append('```');
  }
}

const rendered = output.join('');
process.stdout.write(rendered);

if (summaryPath) {
  appendFileSync(summaryPath, rendered);
}
