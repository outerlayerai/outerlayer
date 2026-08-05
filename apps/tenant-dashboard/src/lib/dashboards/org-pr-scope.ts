/**
 * Org-scope adapter for the PR-lifecycle metrics — pure functions.
 *
 * Under app scope, PR rows and session attribution are joined by APP
 * identity (both sides pre-scoped to one app = one repo), so bare branch
 * names and PR numbers are unambiguous. Org scope sweeps every repo in the
 * tenant, where `main` and `#12` exist in ALL of them — matching on bare
 * identifiers would cross-attribute unrelated repos' work.
 *
 * Rather than teaching every pure function in `pr-metrics.ts` about repos,
 * this module rewrites both sides into org-unique identifiers ONCE, before
 * the math runs:
 *  - `head_branch`/attribution branches → `<repoKey>:<branch>`
 *  - `pr_number`/attribution PR numbers → `repoIndex·10⁷ + pr_number`
 * Equality is all the metric functions ever test on these fields, so the
 * rewrite is invisible to them — and the numeric offset keeps `pr_number`
 * a number (provider PR numbers sit far below 10⁷; the largest public
 * GitHub repos are at ~10⁵).
 *
 * The two sides also name repos differently — sessions report a
 * host-qualified repo (`github.com/owner/repo`, or a full clone URL),
 * `git_connection.repository` a bare `owner/repo` path — so both normalize
 * through `normalizeRepoKey` before matching.
 */

import type { AgentAutonomyLadderItem, AgentPrAttributionItem } from '@repo/api-types';
import type {
  AgentPrAttribution,
  AutonomyLadderItem,
  PrCostAttributionRow,
  PrLifecycleRow,
} from './pr-metrics';

/**
 * Canonical repo key: lowercased path with protocol, `git@` prefix, host
 * segment, and `.git` suffix stripped — `https://GitHub.com/Acme/API.git`,
 * `git@github.com:acme/api`, `github.com/acme/api` and `acme/api` all
 * normalize to `acme/api`. The host segment is recognized by its dot
 * (GitHub owners and GitLab root groups cannot contain dots), which also
 * keeps self-managed hosts (`gitlab.mycorp.io/group/sub/project`) working.
 * Empty/unknown input → `''` (callers treat that as "unmatchable").
 */
export function normalizeRepoKey(repo: string | null | undefined): string {
  let key = (repo ?? '').trim().toLowerCase();
  if (!key) return '';
  key = key.replace(/^[a-z+]+:\/\//, ''); // protocol
  key = key.replace(/^git@/, '').replace(':', '/'); // ssh form
  key = key.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  const segments = key.split('/').filter(Boolean);
  if (segments.length > 1 && segments[0]!.includes('.')) segments.shift(); // host
  return segments.join('/');
}

/** PR numbers are namespaced per repo in blocks of 10M — far above any real
 * provider number, far below Number.MAX_SAFE_INTEGER even at 10⁵ repos. */
const REPO_NUMBER_BLOCK = 10_000_000;

interface OrgPrScopeInput {
  /** Tenant-wide decided PR rows, each tagged with its app's connected repo
   * (possibly `''`) and app id — `fetchDecidedPullRequestsForTenant`'s shape. */
  rows: readonly (PrLifecycleRow & { repo: string; app_id: string })[];
  /** Repo-qualified session attribution rows (`getAgentPrAttribution().items`). */
  attributionItems: readonly AgentPrAttributionItem[];
  /** Repo-qualified per-(branch, PR) session spend (`getAgentPrCostAttribution().items`). */
  costItems: readonly { repo: string; branch: string; prNumber: number; costUsd: number }[];
  /** Repo-qualified ladder verdicts (`getAutonomyLadderAttribution().items`). Optional —
   * only the ladder widgets fetch them. */
  ladderItems?: readonly AgentAutonomyLadderItem[];
}

interface OrgPrScopeResult {
  rows: PrLifecycleRow[];
  attribution: AgentPrAttribution;
  costRows: PrCostAttributionRow[];
  ladderItems: AutonomyLadderItem[];
}

/**
 * Rewrites tenant-wide PR rows + attribution into org-unique identifiers so
 * the app-scope metric functions run unchanged (see the module header).
 *
 * Unmatchable sides are handled asymmetrically, both directions erring
 * toward UNDER-attribution (an unattributed PR still counts in every
 * denominator; a false attribution would corrupt the comparison):
 *  - a PR row whose app has no connected repo gets a private `app:<id>` key —
 *    it keeps its place in totals but can never match a session;
 *  - an attribution/cost row with no repo tag is DROPPED — a bare `main`
 *    with no repo would otherwise match every repo's `main` at once.
 */
export function namespaceOrgPrData(input: OrgPrScopeInput): OrgPrScopeResult {
  // Deterministic repo indexing: every key either side mentions, sorted.
  const keys = new Set<string>();
  for (const row of input.rows) {
    keys.add(normalizeRepoKey(row.repo) || `app:${row.app_id}`);
  }
  for (const item of input.attributionItems) {
    const key = normalizeRepoKey(item.repo);
    if (key) keys.add(key);
  }
  for (const item of input.costItems) {
    const key = normalizeRepoKey(item.repo);
    if (key) keys.add(key);
  }
  for (const item of input.ladderItems ?? []) {
    const key = normalizeRepoKey(item.repo);
    if (key) keys.add(key);
  }
  const indexByKey = new Map([...keys].sort().map((key, i) => [key, i]));

  const namespaceNumber = (key: string, prNumber: number): number =>
    (indexByKey.get(key)! + 1) * REPO_NUMBER_BLOCK + prNumber;
  const namespaceBranch = (key: string, branch: string): string =>
    branch === '' ? '' : `${key}:${branch}`;

  const rows: PrLifecycleRow[] = input.rows.map((row) => {
    const key = normalizeRepoKey(row.repo) || `app:${row.app_id}`;
    const { repo: _repo, app_id: _appId, ...rest } = row;
    return {
      ...rest,
      pr_number: namespaceNumber(key, row.pr_number),
      head_branch: namespaceBranch(key, row.head_branch),
    };
  });

  const branches = new Set<string>();
  const prNumbers = new Set<number>();
  const steeredPrNumbers = new Set<number>();
  for (const item of input.attributionItems) {
    const key = normalizeRepoKey(item.repo);
    if (!key) continue;
    if (item.branch !== '') branches.add(namespaceBranch(key, item.branch));
    if (item.prNumber > 0) {
      const n = namespaceNumber(key, item.prNumber);
      prNumbers.add(n);
      if (item.steered) steeredPrNumbers.add(n);
    }
  }

  const costRows: PrCostAttributionRow[] = input.costItems.flatMap((item) => {
    const key = normalizeRepoKey(item.repo);
    if (!key) return [];
    return [
      {
        branch: namespaceBranch(key, item.branch),
        prNumber: item.prNumber > 0 ? namespaceNumber(key, item.prNumber) : 0,
        costUsd: item.costUsd,
      },
    ];
  });

  const ladderItems: AutonomyLadderItem[] = (input.ladderItems ?? []).flatMap((item) => {
    const key = normalizeRepoKey(item.repo);
    if (!key) return [];
    return [
      {
        branch: namespaceBranch(key, item.branch),
        prNumber: item.prNumber > 0 ? namespaceNumber(key, item.prNumber) : 0,
        minLevel: item.minLevel,
        classifiedSessions: item.classifiedSessions,
      },
    ];
  });

  return {
    rows,
    attribution: {
      branches: [...branches],
      prNumbers: [...prNumbers],
      steeredPrNumbers: [...steeredPrNumbers],
    },
    costRows,
    ladderItems,
  };
}
