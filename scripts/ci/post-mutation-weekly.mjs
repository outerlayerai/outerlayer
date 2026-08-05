#!/usr/bin/env node

/**
 * Posts a weekly mutation-score summary comment on a tracking issue.
 *
 * Inputs (env vars):
 *   GITHUB_TOKEN          - token with issues: write
 *   GITHUB_REPOSITORY     - owner/repo
 *   CURRENT_SCORES_DIR    - directory with score-<workspace>.json from today's run
 *   PREVIOUS_SCORES_DIR   - (optional) directory with score-<workspace>.json from ~1 week ago
 *   TRACKING_ISSUE_LABEL  - label used to find/create the tracking issue
 *                           (default: stryker-tracking)
 *
 * Behavior:
 *   - Finds or creates an issue with TRACKING_ISSUE_LABEL.
 *   - Posts a comment containing per-workspace current score + delta vs previous.
 *   - Exits 0 on success; 1 if API calls fail.
 *
 * Intended to run only on Mondays (or any other cadence controlled by the
 * workflow's conditional on `github.event.schedule`).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  CURRENT_SCORES_DIR = '/tmp/current-scores',
  PREVIOUS_SCORES_DIR = '/tmp/previous-scores',
  TRACKING_ISSUE_LABEL = 'stryker-tracking',
} = process.env;

const ISSUE_TITLE = '[Stryker] Mutation Score Tracking';

function loadScores(dir) {
  if (!existsSync(dir)) return new Map();
  const files = readdirSync(dir).filter((f) => f.startsWith('score-') && f.endsWith('.json'));
  const byWorkspace = new Map();
  for (const f of files) {
    // Skip per-shard files (score-gateway-services.json, score-gateway-routes-big.json,
    // etc.). The aggregate-gateway workflow step produces a combined
    // score-gateway.json that represents gateway as a single workspace
    // for the summary — using the shards directly would surface each
    // one as its own (confusing) row in the weekly table.
    if (/^score-gateway-[a-z-]+\.json$/.test(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      byWorkspace.set(parsed.workspace, parsed);
    } catch {
      // skip malformed score files
    }
  }
  return byWorkspace;
}

async function gh(url, init = {}) {
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

async function findOrCreateTrackingIssue() {
  const list = await gh(
    `/repos/${GITHUB_REPOSITORY}/issues?state=all&labels=${encodeURIComponent(TRACKING_ISSUE_LABEL)}&per_page=1`,
  );
  if (Array.isArray(list) && list.length > 0) {
    return list[0];
  }
  return gh(`/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: ISSUE_TITLE,
      labels: [TRACKING_ISSUE_LABEL],
      body: [
        'Automated tracking issue. Nightly Stryker runs post weekly comments here.',
        '',
        `Workflow: \`.github/workflows/stryker-nightly.yml\``,
        `Break threshold: 80% (configured in each workspace's \`stryker.config.mjs\`).`,
      ].join('\n'),
    }),
  });
}

function formatDelta(current, previous) {
  if (previous === undefined || previous === null) return '(no prior)';
  const delta = current - previous;
  if (Math.abs(delta) < 0.01) return '(—)';
  const sign = delta > 0 ? '+' : '';
  return `(${sign}${delta.toFixed(2)})`;
}

function buildComment(current, previous) {
  const workspaces = [...new Set([...current.keys(), ...previous.keys()])].sort();
  if (workspaces.length === 0) {
    return 'No mutation scores available for this period.';
  }

  const rows = [
    '| Workspace | Score | Δ vs last week | Killed | Survived | Timeout | No coverage |',
    '|-----------|------:|---------------:|-------:|---------:|--------:|------------:|',
  ];
  for (const ws of workspaces) {
    const c = current.get(ws);
    const p = previous.get(ws);
    if (!c) {
      rows.push(`| ${ws} | _missing_ | — | — | — | — | — |`);
      continue;
    }
    rows.push(
      `| ${ws} | ${c.score.toFixed(2)}% | ${formatDelta(c.score, p?.score)} | ${c.killed} | ${c.survived} | ${c.timeout} | ${c.noCoverage} |`,
    );
  }

  const now = new Date().toISOString().slice(0, 10);
  return [
    `### Weekly mutation score — ${now}`,
    '',
    rows.join('\n'),
    '',
    '_Scores below the 80% break threshold would have failed the nightly workflow. Unchanged scores indicate the tests are still effective but not yet improved._',
  ].join('\n');
}

async function main() {
  const current = loadScores(CURRENT_SCORES_DIR);
  const previous = loadScores(PREVIOUS_SCORES_DIR);
  const body = buildComment(current, previous);
  const dryRun = process.argv.includes('--dry-run') || !GITHUB_TOKEN || !GITHUB_REPOSITORY;

  console.log(body);

  if (dryRun) {
    console.log('\n(dry run — skipping issue comment. Set GITHUB_TOKEN + GITHUB_REPOSITORY to post.)');
    return;
  }

  const issue = await findOrCreateTrackingIssue();
  await gh(`/repos/${GITHUB_REPOSITORY}/issues/${issue.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });

  console.log(`\nPosted to issue #${issue.number}: ${issue.html_url}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
