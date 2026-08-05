#!/usr/bin/env node

/**
 * Patch coverage gate.
 *
 * Computes the percentage of newly added/modified TS source lines that are
 * covered by tests, and fails CI if below threshold.
 *
 * Why this exists alongside the aggregate coverage floor:
 *   - Aggregate floors don't catch PRs that add untested code as long as the
 *     workspace's existing coverage subsidises it.
 *   - Aggregate floors DO block PRs that add tests but happen to nudge a
 *     branch metric below floor on a small-base workspace (a fractional
 *     percentage-point gap can fail the whole build).
 *   - Patch coverage scopes the gate to "did the new code in THIS PR ship
 *     with tests" — actionable for the author, doesn't punish them for
 *     someone else's untested historical code.
 *   - Codecov: https://about.codecov.io/blog/why-patch-coverage-is-more-important-than-project-coverage/
 *
 * Inputs (env vars):
 *   GITHUB_TOKEN              token for the GitHub API (required)
 *   GITHUB_REPOSITORY         owner/repo (required)
 *   PR_NUMBER                 pull request number (required)
 *   PATCH_COVERAGE_THRESHOLD  minimum patch line coverage % (default: 70)
 *   PATCH_COVERAGE_MIN_LINES  exit 0 if fewer than this many instrumented
 *                             lines changed (default: 10)
 *
 * Exit codes:
 *   0  patch coverage at or above threshold, OR fewer than MIN_LINES changed
 *   1  patch coverage below threshold
 *   2  config / API failure (missing inputs, bad response)
 */

import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = process.cwd();
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const threshold = Number(process.env.PATCH_COVERAGE_THRESHOLD ?? 70);
const minLines = Number(process.env.PATCH_COVERAGE_MIN_LINES ?? 10);

// Security/money-sensitive source paths get a STRICTER bar with NO
// small-patch exemption — a 3-line change to a webhook signature check, the
// BFF auth wrapper, or a billing-meter amount must ship with a test. This
// closes the hole where the global MIN_LINES skip lets a tiny but high-risk
// diff merge untested. See the test-strategy P0 gate-hardening roadmap.
const sensitiveThreshold = Number(process.env.PATCH_COVERAGE_SENSITIVE_THRESHOLD ?? 80);
const SENSITIVE_PATTERNS = [
  /\/api\/webhooks\//, // inbound Stripe / GitHub webhooks (signature boundary)
  /\/api\/cli\//, // dev-key minting + app listing (Bearer-auth surface)
  /\/api\/platform-admin\//, // privileged cross-tenant ops
  /\/api\/internal\//, // builder-secret channels
  /\/(middleware|with-api|require-app-context|tenant-context)\.[tj]sx?$/, // BFF auth boundary + wrapper
  // Dashboard auth + billing dirs — auth LOGIC, not auth CHROME. The
  // lookbehind excludes src/layouts/auth/ (the branded login panel is
  // visual composition reviewed by eyes; a marketing panel must not
  // inherit webhook-grade thresholds).
  /(?<!\/layouts)\/(auth|billing|entitlements?)\//,
  /(verify-key|verify-bearer|unkey|permissions|rate-limit)\.[tj]sx?$/, // gateway auth + limits
  /(entitlement|stripe-meter|storage-metering|dlq-handler)/i, // money math + trace-loss sink
];
export const isSensitive = (filename) =>
  SENSITIVE_PATTERNS.some((re) => re.test(filename));

const COVERAGE_ROOTS = ['apps', 'packages'];
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;
const TEST_DIR_RE = /(^|\/)(__tests__|__mocks__|test-helpers|test-utils|fixtures)\//;
const SOURCE_FILE_RE = /^(apps|packages)\/[^/]+\/src\/.+\.(ts|tsx)$/;


// ─────────────────────────────────────────────────────────────────────────────
// LCOV parser. Reads each workspace's coverage/lcov.info into a global
// Map<repoRelPath, Map<lineNum, hits>>. We only need DA records (line hits);
// branch and function records are ignored — patch coverage is line-only.
// ─────────────────────────────────────────────────────────────────────────────

function findLcovFiles() {
  // Each entry is { lcovPath, workspaceRel } where workspaceRel is the
  // repo-relative directory of the workspace ("apps/builder" etc.) — used
  // to resolve relative SF paths in the lcov file against the repo root.
  const files = [];
  for (const root of COVERAGE_ROOTS) {
    const resolved = path.join(cwd, root);
    if (!existsSync(resolved)) continue;
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const lcovPath = path.join(resolved, entry.name, 'coverage/lcov.info');
      if (existsSync(lcovPath)) {
        files.push({ lcovPath, workspaceRel: `${root}/${entry.name}` });
      }
    }
  }
  return files;
}

function normalizeSourcePath(rawPath, workspaceRel) {
  // vitest's v8 lcov reporter usually emits paths relative to the workspace
  // (e.g. "src/handler.ts"), but historic versions emit absolute paths. The
  // GitHub PR files API uses repo-relative paths ("apps/builder/src/...");
  // produce that form for matching.
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('/')) {
    // Absolute — trim down to the first known workspace root.
    for (const root of COVERAGE_ROOTS) {
      const idx = trimmed.indexOf(`/${root}/`);
      if (idx !== -1) return trimmed.slice(idx + 1);
    }
    return trimmed;
  }
  // Relative — join with the workspace path.
  return path.posix.join(workspaceRel, trimmed);
}

function parseLcov(filePath, workspaceRel) {
  const records = new Map();
  const text = readFileSync(filePath, 'utf8');
  let currentLines = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const rel = normalizeSourcePath(line.slice(3), workspaceRel);
      currentLines = records.get(rel);
      if (!currentLines) {
        currentLines = new Map();
        records.set(rel, currentLines);
      }
    } else if (line.startsWith('DA:') && currentLines) {
      const [lineNumStr, hitsStr] = line.slice(3).split(',');
      const lineNum = Number(lineNumStr);
      const hits = Number(hitsStr);
      const existing = currentLines.get(lineNum) ?? 0;
      currentLines.set(lineNum, Math.max(existing, hits));
    } else if (line === 'end_of_record') {
      currentLines = null;
    }
  }
  return records;
}

function loadAllCoverage() {
  const all = new Map();
  for (const { lcovPath, workspaceRel } of findLcovFiles()) {
    const records = parseLcov(lcovPath, workspaceRel);
    for (const [relPath, lines] of records) {
      const existing = all.get(relPath);
      if (!existing) {
        all.set(relPath, lines);
      } else {
        for (const [n, h] of lines) {
          existing.set(n, Math.max(existing.get(n) ?? 0, h));
        }
      }
    }
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source-level ignore directives. Parses /* c8 ignore */ and /* v8 ignore */
// comments from the source file and returns the set of 1-indexed line numbers
// that c8 would exclude from instrumentation. Used to honour ignore directives
// in files that are included via coverage.all but never imported by any test
// (so the runtime c8 instrumentation never processes them, leaving all DA lines
// at 0 hits even when the developer explicitly opted them out).
// ─────────────────────────────────────────────────────────────────────────────

function parseSourceIgnoredLines(absPath) {
  const ignored = new Set();
  if (!existsSync(absPath)) return ignored;
  const lines = readFileSync(absPath, 'utf8').split('\n');
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1; // 1-indexed
    const line = lines[i];
    if (/\/\*\s*(c8|v8) ignore start\b/.test(line)) inBlock = true;
    if (inBlock) ignored.add(lineNum);
    if (/\/\*\s*(c8|v8) ignore stop\b/.test(line)) inBlock = false;
    const m = /\/\*\s*(c8|v8) ignore next\s*(\d+)?\s*\*\//.exec(line);
    if (m) {
      const count = m[2] ? Number(m[2]) : 1;
      for (let j = 1; j <= count; j++) ignored.add(lineNum + j);
    }
  }
  return ignored;
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub PR files API. Same auth pattern as report-coverage-delta.mjs.
// ─────────────────────────────────────────────────────────────────────────────

async function ghFetch(url) {
  const response = await fetch(`https://api.github.com${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${url} -> ${response.status}: ${body}`);
  }
  return response.json();
}

async function loadPrFiles() {
  const all = [];
  let page = 1;
  while (true) {
    const items = await ghFetch(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (!items || items.length === 0) break;
    all.push(...items);
    if (items.length < 100) break;
    page += 1;
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch parser. Extracts new-file line numbers for `+`-prefixed lines from a
// unified-diff patch (the format the PR files API returns in `.patch`).
// ─────────────────────────────────────────────────────────────────────────────

function parseAddedLines(patch) {
  const added = [];
  if (!patch) return added;

  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      added.push(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      // removed line: don't advance new-file counter
    } else {
      newLine += 1; // context line
    }
  }
  return added;
}

function shouldCheck(file) {
  if (file.status === 'removed') return false;
  const name = file.filename;
  if (!SOURCE_FILE_RE.test(name)) return false;
  if (TEST_FILE_RE.test(name) || TEST_DIR_RE.test(name)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

function writeSummary(text) {
  if (!summaryPath) return;
  appendFileSync(summaryPath, text);
}

async function main() {
  if (!token || !repo || !prNumber) {
    console.error('GITHUB_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER must be set.');
    return 2;
  }

  const coverage = loadAllCoverage();
  const prFiles = await loadPrFiles();

  let totalLines = 0;
  let coveredLines = 0;
  let sensitiveTotal = 0;
  let sensitiveCovered = 0;
  const rows = [];
  const skipped = [];

  for (const file of prFiles) {
    if (!shouldCheck(file)) continue;

    const added = parseAddedLines(file.patch);
    if (added.length === 0) continue;

    const fileCoverage = coverage.get(file.filename);
    if (!fileCoverage) {
      skipped.push({ file: file.filename, reason: 'no lcov record (file not under any coverage config or not exercised by tests)' });
      continue;
    }

    let fileTotal = 0;
    let fileCovered = 0;
    const sourceIgnored = parseSourceIgnoredLines(path.join(cwd, file.filename));
    for (const lineNum of added) {
      // Honour explicit /* c8 ignore */ / /* v8 ignore */ directives from the
      // source file. Needed for files included via coverage.all that are never
      // imported by tests (runtime c8 never processes their ignore comments).
      if (sourceIgnored.has(lineNum)) continue;
      const hits = fileCoverage.get(lineNum);
      // Lines without DA records are non-instrumentable (comments, blanks,
      // type-only declarations). Don't count them in the denominator.
      if (hits === undefined) continue;
      fileTotal += 1;
      if (hits > 0) fileCovered += 1;
    }

    if (fileTotal === 0) continue;

    totalLines += fileTotal;
    coveredLines += fileCovered;
    const sensitive = isSensitive(file.filename);
    if (sensitive) {
      sensitiveTotal += fileTotal;
      sensitiveCovered += fileCovered;
    }
    rows.push({
      file: file.filename,
      total: fileTotal,
      covered: fileCovered,
      pct: (fileCovered / fileTotal) * 100,
      sensitive,
    });
  }

  const out = ['## Patch Coverage', ''];

  if (totalLines === 0) {
    out.push('_No instrumented source lines changed in this PR. Skipping patch coverage check._');
    const rendered = out.join('\n') + '\n';
    console.log(rendered);
    writeSummary(rendered);
    return 0;
  }

  const pct = (coveredLines / totalLines) * 100;
  const passing = pct >= threshold;
  const skippingDueToSize = totalLines < minLines;

  // Sensitive lines are gated separately and are NOT size-exempt: any
  // instrumented change to an auth / webhook / billing path must hit
  // sensitiveThreshold regardless of overall patch size.
  const sensitivePct = sensitiveTotal > 0 ? (sensitiveCovered / sensitiveTotal) * 100 : 100;
  const sensitiveFailing = sensitiveTotal > 0 && sensitivePct < sensitiveThreshold;

  const willFail = (!passing && !skippingDueToSize) || sensitiveFailing;

  const verdict = willFail ? 'FAIL' : passing ? 'PASS' : 'PASS (small patch)';
  out.push(
    `**${verdict}** — ${coveredLines}/${totalLines} new+modified lines covered = **${pct.toFixed(2)}%** ` +
      `(threshold: ${threshold.toFixed(2)}%)`
  );
  out.push('');

  if (skippingDueToSize) {
    out.push(
      `_Patch has fewer than ${minLines} instrumented lines; not enforcing the global threshold (sensitive paths are still enforced)._`
    );
    out.push('');
  }

  if (sensitiveTotal > 0) {
    const mark = sensitiveFailing ? '❌' : '✅';
    out.push(
      `${mark} **Sensitive paths** (auth / webhooks / billing / DLQ): ${sensitiveCovered}/${sensitiveTotal} new+modified lines covered = ` +
        `**${sensitivePct.toFixed(2)}%** (threshold: ${sensitiveThreshold.toFixed(2)}%, no small-patch exemption)`
    );
    out.push('');
  }

  if (rows.length > 0) {
    out.push('| File | Lines added | Covered | % |');
    out.push('|---|---:|---:|---:|');
    rows.sort((a, b) => a.pct - b.pct);
    for (const row of rows) {
      const tag = row.sensitive ? ' 🔒' : '';
      out.push(`| \`${row.file}\`${tag} | ${row.total} | ${row.covered} | ${row.pct.toFixed(2)}% |`);
    }
  }

  if (skipped.length > 0) {
    out.push('');
    out.push('### Files skipped (no coverage data)');
    for (const s of skipped) out.push(`- \`${s.file}\` — ${s.reason}`);
  }

  const rendered = out.join('\n') + '\n';
  console.log(rendered);
  writeSummary(rendered);

  return willFail ? 1 : 0;
}

// Only execute when run as a script — the module is also imported by
// scripts/__tests__/check-patch-coverage.test.ts to pin the sensitive-path
// boundary.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await main();
    process.exit(code);
  } catch (err) {
    console.error(`patch-coverage check failed: ${err.message}`);
    process.exit(2);
  }
}
