#!/usr/bin/env node

/**
 * Posts or updates a sticky PR comment with coverage delta across all
 * workspaces that produce `coverage/coverage-summary.json` files.
 *
 * Inputs (env vars):
 *   GITHUB_TOKEN       - token with pull-requests: write permission
 *   GITHUB_REPOSITORY  - owner/repo
 *   PR_NUMBER          - pull request number
 *   BASELINE_DIR       - directory containing main's baseline coverage summaries
 *                        (same shape as the repo: apps/*, packages/*).
 *                        Optional; if absent, deltas render as "(—)".
 *   CHANGED_FILES_PATH - file with one changed path per line (git diff output).
 *                        Optional; if absent, "Files you touched" section is skipped.
 *
 * Flags:
 *   --dry-run          - print comment body to stdout, don't post.
 *
 * Exit code is always 0: coverage comments are a signal, not a gate. The
 * floor-enforcement step already exists and fails CI on regressions.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const dryRun = process.argv.includes('--dry-run');

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  BASELINE_DIR = '/tmp/coverage-baseline',
  CHANGED_FILES_PATH = '/tmp/changed-files.txt',
  BASELINE_SHA,
} = process.env;

const COMMENT_MARKER = '<!-- coverage-report-bot -->';
const MAX_FILES_SHOWN = 15;
const BOLD_DELTA_THRESHOLD = 0.5;

function workspaceDirs() {
  const roots = ['apps', 'packages'];
  const dirs = [];
  for (const root of roots) {
    const resolved = path.join(cwd, root);
    if (!existsSync(resolved)) continue;
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
    }
  }
  return dirs;
}

function readSummaryTotals(baseDir, label) {
  const file = path.join(baseDir, label, 'coverage/coverage-summary.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function relPath(absPath) {
  // Coverage summary keys are absolute on the CI runner. Normalize to a path
  // relative to the repo root so it matches `git diff --name-only` output.
  for (const root of ['apps/', 'packages/']) {
    const idx = absPath.indexOf(`/${root}`);
    if (idx !== -1) return absPath.slice(idx + 1);
  }
  return absPath;
}

function formatPct(n) {
  return `${n.toFixed(2)}%`;
}

function formatDelta(current, baseline) {
  if (baseline === null || baseline === undefined) return '(—)';
  const delta = current - baseline;
  if (Math.abs(delta) < 0.01) return '(—)';
  const sign = delta > 0 ? '+' : '';
  const text = `(${sign}${delta.toFixed(2)})`;
  return Math.abs(delta) >= BOLD_DELTA_THRESHOLD ? `**${text}**` : text;
}

function loadChangedFiles() {
  if (!existsSync(CHANGED_FILES_PATH)) return [];
  return readFileSync(CHANGED_FILES_PATH, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildOverallTable(rows) {
  const lines = [
    '| Workspace | Statements | Branches | Functions | Lines |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const r of rows) {
    const cell = (m) => `${formatPct(r.current[m])} ${formatDelta(r.current[m], r.baseline?.[m])}`;
    lines.push(`| ${r.label} | ${cell('statements')} | ${cell('branches')} | ${cell('functions')} | ${cell('lines')} |`);
  }
  return lines.join('\n');
}

function buildTouchedFilesSection(rows, changedFiles) {
  if (changedFiles.length === 0) return '';

  const changedSet = new Set(changedFiles);
  const touched = [];

  for (const r of rows) {
    for (const [absKey, entry] of Object.entries(r.summary)) {
      if (absKey === 'total') continue;
      const rel = relPath(absKey);
      if (!changedSet.has(rel)) continue;
      const baselineEntry = r.baselineSummary?.[absKey];
      const baselineLines = baselineEntry?.lines?.pct ?? null;
      touched.push({
        path: rel,
        linesPct: entry.lines.pct,
        baselineLinesPct: baselineLines,
        isNew: baselineEntry === undefined,
      });
    }
  }

  if (touched.length === 0) return '';

  touched.sort((a, b) => a.linesPct - b.linesPct);
  const shown = touched.slice(0, MAX_FILES_SHOWN);
  const hidden = touched.length - shown.length;

  const header = `### Files you touched (${touched.length} total${hidden > 0 ? `, showing ${MAX_FILES_SHOWN} lowest-coverage` : ''})`;
  const tableLines = [
    header,
    '',
    '| File | Lines covered | Status |',
    '|---|---:|---|',
  ];
  for (const t of shown) {
    const status = t.isNew ? '_new_' : formatDelta(t.linesPct, t.baselineLinesPct);
    tableLines.push(`| \`${t.path}\` | ${formatPct(t.linesPct)} | ${status} |`);
  }
  if (hidden > 0) tableLines.push('', `_+${hidden} more changed files not shown._`);
  return tableLines.join('\n');
}

function buildComment(rows, changedFiles) {
  const sections = [
    COMMENT_MARKER,
    '## Coverage Report',
    '',
    '### Overall',
    '',
    buildOverallTable(rows),
  ];

  const touched = buildTouchedFilesSection(rows, changedFiles);
  if (touched) sections.push('', touched);

  const footer = BASELINE_SHA
    ? `_Baseline from \`main@${BASELINE_SHA.slice(0, 7)}\`._`
    : '_No baseline available yet — deltas will appear once the `coverage-baseline` workflow has run on `main`._';
  sections.push('', footer);

  return sections.join('\n');
}

async function ghFetch(url, init = {}) {
  const response = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init.method ?? 'GET'} ${url} → ${response.status}: ${body}`);
  }
  return response.status === 204 ? null : response.json();
}

async function findExistingComment() {
  let page = 1;
  while (true) {
    const comments = await ghFetch(
      `/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100&page=${page}`,
    );
    if (!comments || comments.length === 0) return null;
    const match = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (match) return match;
    if (comments.length < 100) return null;
    page += 1;
  }
}

async function postOrUpdate(body) {
  const existing = await findExistingComment();
  if (existing) {
    await ghFetch(`/repos/${GITHUB_REPOSITORY}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    return { action: 'updated', id: existing.id };
  }
  const created = await ghFetch(`/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { action: 'created', id: created.id };
}

async function main() {
  const rows = [];
  for (const label of workspaceDirs()) {
    const summary = readSummaryTotals(cwd, label);
    if (!summary) continue;
    const baselineSummary = readSummaryTotals(BASELINE_DIR, label);
    rows.push({
      label,
      current: {
        statements: summary.total.statements.pct,
        branches: summary.total.branches.pct,
        functions: summary.total.functions.pct,
        lines: summary.total.lines.pct,
      },
      baseline: baselineSummary
        ? {
            statements: baselineSummary.total.statements.pct,
            branches: baselineSummary.total.branches.pct,
            functions: baselineSummary.total.functions.pct,
            lines: baselineSummary.total.lines.pct,
          }
        : null,
      summary,
      baselineSummary,
    });
  }

  if (rows.length === 0) {
    console.log('No coverage summaries found. Skipping comment.');
    process.exit(0);
  }

  rows.sort((a, b) => a.label.localeCompare(b.label));
  const changedFiles = loadChangedFiles();
  const body = buildComment(rows, changedFiles);

  if (dryRun) {
    console.log(body);
    process.exit(0);
  }

  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) {
    console.error('GITHUB_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER must be set to post. Use --dry-run to preview.');
    process.exit(0);
  }

  try {
    const result = await postOrUpdate(body);
    console.log(`Comment ${result.action} (id=${result.id})`);
  } catch (err) {
    console.error(`Failed to post comment: ${err.message}`);
  }
}

main();
