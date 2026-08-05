#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const cwd = process.cwd();
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const floorsPath = path.join(cwd, 'scripts/ci/type-suppression-floors.json');

const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const output = [];
const failures = [];

function append(line) {
  output.push(`${line}\n`);
}

function countSuppressions(root) {
  const commonGlobs = "--glob '!**/node_modules/**' --glob '!**/.next/**' --glob '!**/dist/**'";
  const count = (pattern) =>
    Number(
      execSync(`rg -n ${commonGlobs} '${pattern}' ${root} | wc -l`, {
        cwd,
        encoding: 'utf8',
      }).trim(),
    );

  return {
    asAny: count('\\bas any\\b'),
    asUnknownAs: count('as unknown as'),
    tsIgnore: count('@ts-ignore'),
    tsExpectError: count('@ts-expect-error'),
  };
}

append('## Type Suppression Floors');

for (const [root, floor] of Object.entries(floors)) {
  const counts = countSuppressions(root);
  const deltas = [
    ['asAny', 'as any'],
    ['asUnknownAs', 'as unknown as'],
    ['tsIgnore', '@ts-ignore'],
    ['tsExpectError', '@ts-expect-error'],
  ].map(([key, label]) => {
    const actual = counts[key];
    const maxAllowed = floor[key];
    const delta = actual - maxAllowed;
    if (actual > maxAllowed) {
      failures.push(`${root}: ${label} count ${actual} exceeds floor ${maxAllowed}`);
    }
    return `${label} ${actual} vs ${maxAllowed} (${delta > 0 ? '+' : ''}${delta})`;
  });

  append(`- ${root}: ${deltas.join(', ')}`);
}

const rendered = output.join('');
process.stdout.write(rendered);

if (summaryPath) {
  appendFileSync(summaryPath, rendered);
}

if (failures.length > 0) {
  console.error('\nType suppression floor failures:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
