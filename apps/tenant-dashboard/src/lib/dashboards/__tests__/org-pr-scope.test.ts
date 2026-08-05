/**
 * Org-scope PR namespacing — the collision-safety layer under the org
 * rollup. The claims pinned here:
 *  1. `normalizeRepoKey` reconciles the two repo vocabularies (sessions
 *     report host-qualified repos / clone URLs; git_connection stores bare
 *     `owner/repo`).
 *  2. After namespacing, identical branch names and PR numbers in DIFFERENT
 *     repos never cross-attribute — while same-repo matching still works.
 *  3. Unmatchable inputs err toward UNDER-attribution: connection-less PR
 *     rows stay in totals but can't match; repo-less attribution rows are
 *     dropped entirely.
 */

import { namespaceOrgPrData, normalizeRepoKey } from '../org-pr-scope';
import { computeAgentShareOfMergedPrs, isAgentPr, type PrLifecycleRow } from '../pr-metrics';

function row(over: Partial<PrLifecycleRow> & { repo: string; app_id: string }): PrLifecycleRow & { repo: string; app_id: string } {
  return {
    pr_number: 1,
    head_branch: 'main',
    state: 'merged',
    opened_at: '2026-07-01T09:00:00Z',
    closed_at: '2026-07-02T09:00:00Z',
    merged_at: '2026-07-02T09:00:00Z',
    ...over,
  };
}

const WINDOW = { start: '2026-07-01', end: '2026-07-07' };

describe('normalizeRepoKey', () => {
  it('reduces every repo spelling to the same lowercase path', () => {
    // The two vocabularies that must meet: session GitRepo vs git_connection.
    expect(normalizeRepoKey('github.com/Acme/API')).toBe('acme/api');
    expect(normalizeRepoKey('Acme/API')).toBe('acme/api');
    expect(normalizeRepoKey('https://github.com/acme/api.git')).toBe('acme/api');
    expect(normalizeRepoKey('git@github.com:acme/api.git')).toBe('acme/api');
  });

  it('keeps GitLab subgroup paths intact while stripping self-managed hosts', () => {
    expect(normalizeRepoKey('gitlab.mycorp.io/group/sub/project')).toBe('group/sub/project');
    expect(normalizeRepoKey('group/sub/project')).toBe('group/sub/project');
  });

  it('returns empty for empty/blank input (the "unmatchable" sentinel)', () => {
    expect(normalizeRepoKey('')).toBe('');
    expect(normalizeRepoKey(undefined)).toBe('');
    expect(normalizeRepoKey('  ')).toBe('');
  });
});

describe('namespaceOrgPrData', () => {
  it('same branch name and PR number in two repos never cross-attribute; same-repo matching still works', () => {
    // Both repos have a PR #1 with head branch `agent/x`; only repo-a's has
    // agent sessions. Session side reports the host-qualified repo.
    const result = namespaceOrgPrData({
      rows: [
        row({ repo: 'acme/repo-a', app_id: 'app-a', pr_number: 1, head_branch: 'agent/x' }),
        row({ repo: 'acme/repo-b', app_id: 'app-b', pr_number: 1, head_branch: 'agent/x' }),
      ],
      attributionItems: [
        { repo: 'github.com/acme/repo-a', branch: 'agent/x', prNumber: 1, steered: false },
      ],
      costItems: [],
    });

    const [prA, prB] = result.rows;
    expect(isAgentPr(prA!, result.attribution)).toBe(true);
    expect(isAgentPr(prB!, result.attribution)).toBe(false);
    // Namespaced identifiers stay distinct across repos.
    expect(prA!.pr_number).not.toBe(prB!.pr_number);
    expect(prA!.head_branch).not.toBe(prB!.head_branch);
  });

  it('feeds the pure metric functions unchanged — agent share counts only the attributed repo’s merge', () => {
    const result = namespaceOrgPrData({
      rows: [
        row({ repo: 'acme/repo-a', app_id: 'app-a', pr_number: 1, head_branch: 'agent/x' }),
        row({ repo: 'acme/repo-b', app_id: 'app-b', pr_number: 1, head_branch: 'agent/x' }),
        row({ repo: 'acme/repo-b', app_id: 'app-b', pr_number: 2, head_branch: 'human/y' }),
      ],
      attributionItems: [{ repo: 'github.com/acme/repo-a', branch: 'agent/x', prNumber: 0, steered: false }],
      costItems: [],
    });
    const share = computeAgentShareOfMergedPrs(result.rows, result.attribution, WINDOW);
    // 3 merges org-wide, exactly ONE attributable (repo-a's agent/x).
    expect(share.current).toEqual({ agentMerged: 1, totalMerged: 3, share: 1 / 3 });
  });

  it('keeps connection-less PR rows in totals under a private per-app key that can never match sessions', () => {
    const result = namespaceOrgPrData({
      rows: [
        row({ repo: '', app_id: 'app-a', pr_number: 7, head_branch: 'main' }),
        row({ repo: '', app_id: 'app-b', pr_number: 7, head_branch: 'main' }),
      ],
      attributionItems: [{ repo: 'github.com/acme/repo-a', branch: 'main', prNumber: 7, steered: true }],
      costItems: [],
    });
    // Distinct per-app namespaces — the two #7s never merge into one row-identity.
    expect(result.rows[0]!.pr_number).not.toBe(result.rows[1]!.pr_number);
    // And neither matches the session attribution (which belongs to repo-a).
    expect(result.rows.some((r) => isAgentPr(r, result.attribution))).toBe(false);
  });

  it('drops repo-less attribution and cost rows — a bare `main` must not match every repo at once', () => {
    const result = namespaceOrgPrData({
      rows: [row({ repo: 'acme/repo-a', app_id: 'app-a', head_branch: 'main' })],
      attributionItems: [{ repo: '', branch: 'main', prNumber: 9, steered: true }],
      costItems: [{ repo: '', branch: 'main', prNumber: 9, costUsd: 50 }],
    });
    expect(result.attribution).toEqual({ branches: [], prNumbers: [], steeredPrNumbers: [] });
    expect(result.costRows).toEqual([]);
  });

  it('carries steering and cost through the same transform (numbers usable against namespaced rows)', () => {
    const result = namespaceOrgPrData({
      rows: [row({ repo: 'acme/repo-a', app_id: 'app-a', pr_number: 5, head_branch: 'agent/x' })],
      attributionItems: [{ repo: 'acme/repo-a', branch: 'agent/x', prNumber: 5, steered: true }],
      costItems: [{ repo: 'acme/repo-a', branch: 'agent/x', prNumber: 5, costUsd: 12.5 }],
    });
    const namespacedNumber = result.rows[0]!.pr_number;
    expect(result.attribution.prNumbers).toEqual([namespacedNumber]);
    expect(result.attribution.steeredPrNumbers).toEqual([namespacedNumber]);
    expect(result.costRows).toEqual([
      { branch: result.rows[0]!.head_branch, prNumber: namespacedNumber, costUsd: 12.5 },
    ]);
  });

  it('namespaces ladder items through the same transform and drops repo-less ones', () => {
    const result = namespaceOrgPrData({
      rows: [row({ repo: 'acme/repo-a', app_id: 'app-a', pr_number: 5, head_branch: 'agent/x' })],
      attributionItems: [],
      costItems: [],
      ladderItems: [
        { repo: 'github.com/acme/repo-a', branch: 'agent/x', prNumber: 5, minLevel: 3, classifiedSessions: 2 },
        { repo: '', branch: 'main', prNumber: 9, minLevel: 4, classifiedSessions: 1 },
      ],
    });
    expect(result.ladderItems).toEqual([
      {
        branch: result.rows[0]!.head_branch,
        prNumber: result.rows[0]!.pr_number,
        minLevel: 3,
        classifiedSessions: 2,
      },
    ]);
  });

  it('never leaks the raw repo/app fields into the metric rows', () => {
    const result = namespaceOrgPrData({
      rows: [row({ repo: 'acme/repo-a', app_id: 'app-a' })],
      attributionItems: [],
      costItems: [],
    });
    expect(result.rows[0]).not.toHaveProperty('repo');
    expect(result.rows[0]).not.toHaveProperty('app_id');
  });
});
