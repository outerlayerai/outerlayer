#!/usr/bin/env node

/**
 * Enforces the flake quarantine policy: every file in `apps/e2e/tests/.quarantine/`
 * must have the three required headers, and none may exceed the staleness
 * threshold defined below.
 *
 * Required headers at the top of each .spec.ts file:
 *   // quarantined: YYYY-MM-DD
 *   // quarantine-issue: https://github.com/...
 *   // quarantine-reason: one sentence
 *
 * Exits 1 if any file is malformed or stale. Exits 0 otherwise.
 *
 * See apps/e2e/tests/.quarantine/README.md for the process.
 */

import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const quarantineDir = path.join(cwd, 'apps/e2e/tests/.quarantine');
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

// ─────────────────────────────────────────────────────────────────────────────
// STALENESS POLICY — your call. Edit this function, nothing else.
//
// Inputs:
//   info.filePath  - path relative to cwd
//   info.ageDays   - days since `quarantined:` header date
//   info.issueUrl  - from `quarantine-issue:` header (always present at this
//                    point; missing headers fail earlier as a structural error)
//   info.reason    - from `quarantine-reason:` header (always present)
// Returns:
//   { stale: boolean, message: string }
//
// Default below: stale after 14 days. Change to e.g. `ageDays > 30` if you want
// a longer leash, or add logic like "stale if age > 7 AND no PR open on issue".
// Pick what matches your team's urgency on flake cleanup.
// ─────────────────────────────────────────────────────────────────────────────
function isQuarantineStale(info) {
  const HARD_LIMIT_DAYS = 14;
  if (info.ageDays > HARD_LIMIT_DAYS) {
    return {
      stale: true,
      message: `${info.filePath} has been quarantined for ${info.ageDays} days (limit: ${HARD_LIMIT_DAYS}). Fix or delete.`,
    };
  }
  return { stale: false, message: '' };
}

function listSpecFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.spec.ts')) results.push(full);
    }
  };
  walk(dir);
  return results;
}

function parseHeaders(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const head = content.split('\n').slice(0, 30).join('\n');
  const quarantined = head.match(/^\s*\/\/\s*quarantined:\s*(\d{4}-\d{2}-\d{2})/m);
  const issue = head.match(/^\s*\/\/\s*quarantine-issue:\s*(\S+)/m);
  const reason = head.match(/^\s*\/\/\s*quarantine-reason:\s*(.+)$/m);
  return {
    quarantined: quarantined ? quarantined[1] : null,
    issueUrl: issue ? issue[1] : null,
    reason: reason ? reason[1].trim() : null,
  };
}

function ageDays(dateStr) {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function writeStepSummary(text) {
  if (!summaryPath) return;
  appendFileSync(summaryPath, text + '\n');
}

function main() {
  const files = listSpecFiles(quarantineDir);
  const errors = [];
  const staleFindings = [];
  const healthy = [];

  for (const filePath of files) {
    const rel = path.relative(cwd, filePath);
    const headers = parseHeaders(filePath);
    const missing = [];
    if (!headers.quarantined) missing.push('quarantined:');
    if (!headers.issueUrl) missing.push('quarantine-issue:');
    if (!headers.reason) missing.push('quarantine-reason:');
    if (missing.length > 0) {
      errors.push(`${rel} is missing required header(s): ${missing.join(', ')}`);
      continue;
    }

    const age = ageDays(headers.quarantined);
    const verdict = isQuarantineStale({
      filePath: rel,
      ageDays: age,
      issueUrl: headers.issueUrl,
      reason: headers.reason,
    });

    if (verdict.stale) {
      staleFindings.push(verdict.message);
    } else {
      healthy.push(`${rel} (${age} days, ${headers.issueUrl})`);
    }
  }

  const lines = ['## Quarantine Staleness', ''];
  if (files.length === 0) {
    lines.push('No files in quarantine. Nothing to check.');
    console.log(lines.join('\n'));
    writeStepSummary(lines.join('\n'));
    process.exit(0);
  }

  if (healthy.length > 0) {
    lines.push('### Healthy');
    for (const h of healthy) lines.push(`- ${h}`);
  }
  if (errors.length > 0) {
    lines.push('', '### Structural errors');
    for (const e of errors) lines.push(`- ${e}`);
  }
  if (staleFindings.length > 0) {
    lines.push('', '### Stale');
    for (const s of staleFindings) lines.push(`- ${s}`);
  }

  const rendered = lines.join('\n');
  console.log(rendered);
  writeStepSummary(rendered);

  const failed = errors.length > 0 || staleFindings.length > 0;
  process.exit(failed ? 1 : 0);
}

main();
