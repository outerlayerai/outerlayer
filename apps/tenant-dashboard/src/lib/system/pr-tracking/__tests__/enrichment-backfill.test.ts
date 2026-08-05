/**
 * enrichPullRequestsForConnection / backfillPrEnrichment — API-read catch-up
 * for diff size + first-pass CI verdicts. Supabase runs through MSW (no
 * client mocks); the providers are REAL instances with their API-read
 * methods stubbed (their mappings have their own per-provider tests). Pins
 * the never-overwrite contract: only NULL-column candidates are fetched,
 * diff writes guard on `additions IS NULL`, CI writes compare-and-set on
 * `first_ci_sha IS NULL` — a live webhook racing the backfill wins.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Octokit } from 'octokit';
import { server } from '../../../../test-helpers/msw-server';
import { getAdminDataClient } from '@/lib/system/admin-client';
import { GitHubProvider } from '../../git/github/client';
import {
  backfillPrEnrichment,
  enrichPullRequestsForConnection,
  ENRICHMENT_LINK_LIMIT,
} from '../enrichment-backfill';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  withAppId: vi.fn(),
}));
logger.withAppId.mockReturnValue(logger);
vi.mock('@/lib/observability/server-logger', () => ({ serverLogger: logger }));

const gitMocks = vi.hoisted(() => ({ createGitProviderForApp: vi.fn() }));
vi.mock('../../git', () => ({ createGitProviderForApp: gitMocks.createGitProviderForApp }));

const API = 'http://localhost:54321/rest/v1';
const SHA = 'b'.repeat(40);

let candidateUrls: URL[];
let patches: Array<{ url: URL; body: Record<string, unknown> }>;

function seedPullRequests(rows: Array<Record<string, unknown>>) {
  server.use(
    http.get(`${API}/pull_request`, ({ request }) => {
      candidateUrls.push(new URL(request.url));
      return HttpResponse.json(rows);
    }),
    http.patch(`${API}/pull_request`, async ({ request }) => {
      patches.push({ url: new URL(request.url), body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json([]);
    })
  );
}

function stubProvider(over: {
  diff?: { additions: number | null; deletions: number | null; changedFiles: number | null } | Error;
  verdict?: { conclusion: 'success' | 'failure' | null; completedAt: string | null } | Error;
}) {
  const provider = new GitHubProvider(new Octokit({ auth: 't' }));
  const getPullRequestDiffStats = vi
    .spyOn(provider, 'getPullRequestDiffStats')
    .mockImplementation(async () => {
      if (over.diff instanceof Error) throw over.diff;
      return over.diff ?? { additions: null, deletions: null, changedFiles: null };
    });
  const getCommitCiVerdict = vi.spyOn(provider, 'getCommitCiVerdict').mockImplementation(async () => {
    if (over.verdict instanceof Error) throw over.verdict;
    return over.verdict ?? { conclusion: null, completedAt: null };
  });
  return { provider, getPullRequestDiffStats, getCommitCiVerdict };
}

beforeEach(() => {
  vi.clearAllMocks();
  logger.withAppId.mockReturnValue(logger);
  candidateUrls = [];
  patches = [];
});

describe('enrichPullRequestsForConnection', () => {
  it('fetches only NULL-column decided candidates and writes both signals with their guards', async () => {
    seedPullRequests([
      { id: 'pr-1', pr_number: 7, head_sha: SHA, additions: null, first_ci_status: null },
    ]);
    const { provider, getPullRequestDiffStats, getCommitCiVerdict } = stubProvider({
      diff: { additions: 120, deletions: 30, changedFiles: 5 },
      verdict: { conclusion: 'failure', completedAt: '2026-07-10T10:00:00Z' },
    });

    const counts = await enrichPullRequestsForConnection({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      repository: 'acme/repo',
      limit: 50,
    });

    expect(counts).toEqual({ examined: 1, diffFilled: 1, ciFilled: 1, errors: [] });
    expect(getPullRequestDiffStats).toHaveBeenCalledWith('acme/repo', 7);
    expect(getCommitCiVerdict).toHaveBeenCalledWith('acme/repo', SHA);

    // Candidate query: decided-only, recent, NULL-column filter, capped.
    const params = candidateUrls[0]!.searchParams;
    expect(params.get('app_id')).toBe('eq.app-1');
    expect(params.get('state')).toBe('neq.open');
    expect(params.get('or')).toBe('(additions.is.null,first_ci_status.is.null)');
    expect(params.get('limit')).toBe('50');

    // Diff write guards on additions IS NULL; CI write compare-and-sets the sha lock.
    expect(patches).toHaveLength(2);
    const [diff, ci] = patches;
    expect(diff!.body).toEqual({ additions: 120, deletions: 30, changed_files: 5 });
    expect(diff!.url.searchParams.get('additions')).toBe('is.null');
    expect(ci!.body).toEqual({
      first_ci_sha: SHA,
      first_ci_status: 'failure',
      first_ci_at: '2026-07-10T10:00:00Z',
    });
    expect(ci!.url.searchParams.get('first_ci_sha')).toBe('is.null');
  });

  it('skips the CI read for rows with no head sha, and writes nothing for a null verdict', async () => {
    seedPullRequests([
      { id: 'pr-1', pr_number: 8, head_sha: null, additions: 10, first_ci_status: null },
      { id: 'pr-2', pr_number: 9, head_sha: SHA, additions: 10, first_ci_status: null },
    ]);
    const { provider, getCommitCiVerdict } = stubProvider({
      verdict: { conclusion: null, completedAt: null },
    });

    const counts = await enrichPullRequestsForConnection({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      repository: 'acme/repo',
      limit: 50,
    });

    // Only pr-2 had a sha to ask about; its say-nothing verdict writes nothing.
    expect(getCommitCiVerdict).toHaveBeenCalledTimes(1);
    expect(patches).toHaveLength(0);
    expect(counts).toEqual({ examined: 2, diffFilled: 0, ciFilled: 0, errors: [] });
  });

  it('collects per-PR failures and keeps going (best-effort contract)', async () => {
    seedPullRequests([
      { id: 'pr-1', pr_number: 7, head_sha: null, additions: null, first_ci_status: 'success' },
      { id: 'pr-2', pr_number: 8, head_sha: null, additions: null, first_ci_status: 'success' },
    ]);
    const { provider } = stubProvider({ diff: new Error('rate limited') });

    const counts = await enrichPullRequestsForConnection({
      supabase: getAdminDataClient(),
      provider,
      appId: 'app-1',
      repository: 'acme/repo',
      limit: 50,
    });

    expect(counts.examined).toBe(2);
    expect(counts.diffFilled).toBe(0);
    expect(counts.errors).toEqual(['pr 7: rate limited', 'pr 8: rate limited']);
  });
});

describe('backfillPrEnrichment', () => {
  it('sweeps connections (tenant-scoped when asked), aggregating counts across them', async () => {
    let connectionUrl: URL | null = null;
    server.use(
      http.get(`${API}/git_connection`, ({ request }) => {
        connectionUrl = new URL(request.url);
        return HttpResponse.json([{ app_id: 'app-1', repository: 'acme/repo' }]);
      })
    );
    seedPullRequests([
      { id: 'pr-1', pr_number: 7, head_sha: SHA, additions: null, first_ci_status: null },
    ]);
    const { provider } = stubProvider({
      diff: { additions: 1, deletions: 1, changedFiles: 1 },
      verdict: { conclusion: 'success', completedAt: null },
    });
    gitMocks.createGitProviderForApp.mockResolvedValue(provider);

    const result = await backfillPrEnrichment({ tenantId: 'tenant-1', perConnectionLimit: 25 });

    expect(connectionUrl!.searchParams.get('tenant_id')).toBe('eq.tenant-1');
    expect(candidateUrls[0]!.searchParams.get('limit')).toBe('25');
    expect(result).toEqual({
      connections: 1,
      examined: 1,
      diffFilled: 1,
      ciFilled: 1,
      errors: [],
    });
  });

  it('a connection without a provider is recorded, never fatal', async () => {
    server.use(
      http.get(`${API}/git_connection`, () =>
        HttpResponse.json([{ app_id: 'app-broken', repository: 'acme/other' }])
      )
    );
    gitMocks.createGitProviderForApp.mockResolvedValue(null);

    const result = await backfillPrEnrichment({});

    expect(result.connections).toBe(1);
    expect(result.errors).toEqual(['app app-broken: no provider']);
  });
});

describe('ENRICHMENT_LINK_LIMIT', () => {
  it('keeps the deferred link budget inside the function background window (2 API calls per PR)', () => {
    expect(ENRICHMENT_LINK_LIMIT).toBe(200);
  });
});
