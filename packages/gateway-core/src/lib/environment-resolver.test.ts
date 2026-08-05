/**
 * Unit tests for environment-resolver.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveEnvironmentFromApiKey,
  resolveEnvironmentForSelector,
  resolveIngestEnvironment,
  __clearEnvironmentResolverCache,
  EnvironmentResolutionError,
} from './environment-resolver';

/**
 * Minimal stand-in for the `api_key → environment` join query. The resolver
 * issues exactly `from('api_key').select(...).eq(...).eq(...).maybeSingle()`.
 *
 * Pass `environment` for the success path. Pass `{ errorMessage }` to simulate
 * a Supabase row-level error (data:null, error:{...}). Pass `{ throws }` to
 * simulate the client throwing (network-level failure).
 */
function fakeSupabase(opts: {
  environment?: Record<string, unknown> | null;
  errorMessage?: string;
  throws?: Error;
}): SupabaseClient {
  const { environment, errorMessage, throws } = opts;
  const result = throws
    ? Promise.reject(throws)
    : Promise.resolve(
        errorMessage
          ? { data: null, error: { message: errorMessage } }
          : {
              data: environment ? { environment_id: 'env-id', environment } : null,
              error: null,
            },
      );
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

function envRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'env-default',
    name: 'dev',
    is_default: true,
    current_version: 0,
    current_commit_sha: null,
    ...over,
  };
}

beforeEach(() => __clearEnvironmentResolverCache());

describe('resolveEnvironmentFromApiKey — isDefault propagation', () => {
  it('returns isDefault: true when the bound environment is the default env', async () => {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({ environment: envRow({ is_default: true }) }),
      apiKeyId: 'key-default',
      tenantId: 'tenant-1',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.isDefault).toBe(true);
  });

  it('returns isDefault: false for a non-default environment', async () => {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({
        environment: envRow({
          id: 'env-staging',
          name: 'staging',
          is_default: false,
          current_version: 2,
          current_commit_sha: 'abc1234',
        }),
      }),
      apiKeyId: 'key-staging',
      tenantId: 'tenant-1',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.isDefault).toBe(false);
  });
});

describe('resolveEnvironmentFromApiKey — saga-version translation (current_version → pinned_version)', () => {
  // The resolver translates the new monotonic `current_version` field to the
  // legacy `pinned_version` shape its callers know:
  //   current_version = 0  →  pinned_version = null  ("no successful saga yet")
  //   current_version > 0  →  pinned_version = N    (pinned to saga version N)
  // This is the seam every CommitSha / EnvironmentVersion downstream relies
  // on. If the translation breaks, no-pin envs start reporting as pinned
  // (CommitSha policy kicks in incorrectly) and pinned envs lose their
  // version stamping.

  it('translates current_version=0 to pinned_version=null so no-pin envs surface as unpinned', async () => {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({
        environment: envRow({ current_version: 0, current_commit_sha: null }),
      }),
      apiKeyId: 'key-no-pin',
      tenantId: 'tenant-1',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.pinned_version).toBeNull();
    expect(resolved!.pinned_commit_sha).toBeNull();
  });

  it('propagates current_version > 0 verbatim as pinned_version', async () => {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({
        environment: envRow({
          current_version: 7,
          current_commit_sha: 'deadbeefcafef00d',
        }),
      }),
      apiKeyId: 'key-pinned',
      tenantId: 'tenant-1',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.pinned_version).toBe(7);
    expect(resolved!.pinned_commit_sha).toBe('deadbeefcafef00d');
  });

  it('stamps pinned_commit_sha=null when the env has a version but no commit pointer yet', async () => {
    // Defensive: an env can have current_version > 0 but a null
    // current_commit_sha (no pointer advanced yet). We must still degrade to a
    // null commit rather than throwing.
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({
        environment: envRow({ current_version: 3, current_commit_sha: null }),
      }),
      apiKeyId: 'key-pinned-no-deploy',
      tenantId: 'tenant-1',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.pinned_version).toBe(3);
    expect(resolved!.pinned_commit_sha).toBeNull();
  });
});

describe('resolveEnvironmentFromApiKey — no-binding fast path', () => {
  it('returns NO_ENVIRONMENT without touching supabase when apiKeyId is undefined', async () => {
    let dbCalled = false;
    const supabase = {
      from: () => {
        dbCalled = true;
        throw new Error('supabase MUST NOT be called for bearer-auth requests');
      },
    } as unknown as SupabaseClient;

    const resolved = await resolveEnvironmentFromApiKey({
      supabase,
      apiKeyId: undefined,
      tenantId: 'tenant-1',
    });

    expect(resolved).toBeNull();
    expect(dbCalled).toBe(false);
  });
});

describe('resolveEnvironmentFromApiKey — fail-closed mode', () => {
  // Regression: a transient Supabase failure must NOT degrade an env-bound
  // API key to cross-env access. With `failClosed: true`, the resolver throws
  // `EnvironmentResolutionError` instead of returning the NO_ENVIRONMENT
  // sentinel, so analytics read paths surface a 500 rather than silently
  // serving rows from other envs.

  it('throws EnvironmentResolutionError when supabase returns an error and failClosed is true', async () => {
    await expect(
      resolveEnvironmentFromApiKey({
        supabase: fakeSupabase({ errorMessage: 'connection reset' }),
        apiKeyId: 'key-failclosed-error',
        tenantId: 'tenant-1',
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(EnvironmentResolutionError);
  });

  it('throws EnvironmentResolutionError when the client throws and failClosed is true', async () => {
    await expect(
      resolveEnvironmentFromApiKey({
        supabase: fakeSupabase({ throws: new Error('socket hangup') }),
        apiKeyId: 'key-failclosed-throw',
        tenantId: 'tenant-1',
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(EnvironmentResolutionError);
  });

  it('returns null (fail-open) on the same transient error when failClosed is false', async () => {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({ errorMessage: 'connection reset' }),
      apiKeyId: 'key-failopen-error',
      tenantId: 'tenant-1',
    });
    expect(resolved).toBeNull();
  });

  it('returns null on a genuine row-absent miss even when failClosed is true (not a transient error)', async () => {
    const resolved = await resolveEnvironmentFromApiKey({
      supabase: fakeSupabase({ environment: null }),
      apiKeyId: 'key-genuine-miss',
      tenantId: 'tenant-1',
      failClosed: true,
    });
    expect(resolved).toBeNull();
  });

  it('does not poison fail-closed callers via the fail-open cache', async () => {
    // A fail-open caller hits first, sees a transient error, caches the
    // NO_ENVIRONMENT result with the short TTL. A subsequent fail-closed
    // caller for the same key must still throw — the cache entry's
    // transient-error flag must be honored.
    const supabase = fakeSupabase({ errorMessage: 'connection reset' });
    const failOpen = await resolveEnvironmentFromApiKey({
      supabase,
      apiKeyId: 'key-shared-cache',
      tenantId: 'tenant-1',
    });
    expect(failOpen).toBeNull();

    await expect(
      resolveEnvironmentFromApiKey({
        supabase,
        apiKeyId: 'key-shared-cache',
        tenantId: 'tenant-1',
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(EnvironmentResolutionError);
  });
});

// ---------------------------------------------------------------------------
// Meta path: env id from the verified token → resolve `environment` by id.
// ---------------------------------------------------------------------------

interface RecordedQuery {
  table: string;
  filters: Array<[string, unknown]>;
}

/**
 * Table-aware double that records which table was queried and with which `.eq`
 * filters. The `environment` table returns the env row directly; the `api_key`
 * table returns the join shape. Pass `environmentRow: null` to simulate a
 * genuine miss (e.g. wrong tenant, deleted env).
 */
function fakeSupabaseByTable(opts: {
  environmentRow?: Record<string, unknown> | null;
  apiKeyEnvironment?: Record<string, unknown> | null;
}): { supabase: SupabaseClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const supabase = {
    from: (table: string) => {
      const record: RecordedQuery = { table, filters: [] };
      queries.push(record);
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          record.filters.push([col, val]);
          return chain;
        },
        maybeSingle: () => {
          if (table === 'environment') {
            return Promise.resolve({
              data: opts.environmentRow ?? null,
              error: null,
            });
          }
          // api_key join shape
          return Promise.resolve({
            data: opts.apiKeyEnvironment
              ? { environment_id: 'env-id', environment: opts.apiKeyEnvironment }
              : null,
            error: null,
          });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { supabase, queries };
}

describe('resolveEnvironmentFromApiKey — meta path (env id from token)', () => {
  it('resolves the environment directly by id and never touches api_key', async () => {
    const { supabase, queries } = fakeSupabaseByTable({
      environmentRow: envRow({
        id: 'env-prod',
        name: 'prod',
        is_default: false,
        current_version: 9,
        current_commit_sha: 'cafebabe',
      }),
    });

    const resolved = await resolveEnvironmentFromApiKey({
      supabase,
      apiKeyId: 'key-meta',
      tenantId: 'tenant-1',
      environmentIdFromToken: 'env-prod',
    });

    expect(resolved).toEqual({
      id: 'env-prod',
      name: 'prod',
      isDefault: false,
      pinned_version: 9,
      pinned_commit_sha: 'cafebabe',
      targetKind: 'promoted',
    });
    // The whole point of the feature: no api_key-row lookup on the meta path.
    expect(queries.map((q) => q.table)).toEqual(['environment']);
    expect(queries.some((q) => q.table === 'api_key')).toBe(false);
  });

  it('scopes the environment lookup by id AND tenant_id (forged token env id cannot cross tenants)', async () => {
    const { supabase, queries } = fakeSupabaseByTable({
      environmentRow: envRow({ id: 'env-x' }),
    });

    await resolveEnvironmentFromApiKey({
      supabase,
      apiKeyId: 'key-meta',
      tenantId: 'tenant-7',
      environmentIdFromToken: 'env-x',
    });

    const envQuery = queries.find((q) => q.table === 'environment')!;
    expect(envQuery.filters).toContainEqual(['id', 'env-x']);
    expect(envQuery.filters).toContainEqual(['tenant_id', 'tenant-7']);
  });

  it('returns NO_ENVIRONMENT when the env id resolves to no row (wrong tenant / deleted env)', async () => {
    const { supabase } = fakeSupabaseByTable({ environmentRow: null });

    const resolved = await resolveEnvironmentFromApiKey({
      supabase,
      apiKeyId: 'key-meta',
      tenantId: 'tenant-1',
      environmentIdFromToken: 'env-ghost',
    });

    expect(resolved).toBeNull();
  });

  it('falls back to the api_key join when no env id is on the token (legacy key)', async () => {
    const { supabase, queries } = fakeSupabaseByTable({
      apiKeyEnvironment: envRow({ id: 'env-legacy', name: 'legacy' }),
    });

    const resolved = await resolveEnvironmentFromApiKey({
      supabase,
      apiKeyId: 'key-legacy',
      tenantId: 'tenant-1',
      // environmentIdFromToken intentionally omitted — legacy key.
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe('env-legacy');
    expect(queries.map((q) => q.table)).toEqual(['api_key']);
  });
});

// A minimal `from('environment').select().eq()…maybeSingle()` stub that returns
// the env row directly (the selector path maps it via mapEnvironmentRow).
function selectorSupabase(opts: {
  env?: Record<string, unknown> | null;
  errorMessage?: string;
}): SupabaseClient {
  const result = Promise.resolve(
    opts.errorMessage
      ? { data: null, error: { message: opts.errorMessage } }
      : { data: opts.env ?? null, error: null },
  );
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe('resolveEnvironmentForSelector — per-request env selection + kind auth', () => {
  it('returns unauthorized (no lookup) when the key carries no allowed kinds', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({ env: envRow() }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { prNumber: 7 },
      allowedEnvKinds: undefined,
    });
    expect(r).toEqual({ env: null, authorized: false });
  });

  it('returns unauthorized when allowedEnvKinds is empty', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({ env: envRow() }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { prNumber: 7 },
      allowedEnvKinds: [],
    });
    expect(r).toEqual({ env: null, authorized: false });
  });

  it('authorizes a preview-scoped key selecting its PR preview env (by number)', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({
        env: envRow({
          id: 'pr-7',
          name: 'pr-7',
          is_default: false,
          current_version: 0,
          is_ephemeral: true,
        }),
      }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { prNumber: 7 },
      allowedEnvKinds: ['preview'],
    });
    expect(r.authorized).toBe(true);
    expect(r.env?.id).toBe('pr-7');
    expect(r.env?.targetKind).toBe('preview');
  });

  it('resolves the env but reports authorized:false when its kind is not allowed', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({
        env: envRow({
          id: 'prod',
          name: 'production',
          is_default: false,
          current_version: 5,
        }),
      }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { envName: 'production' },
      allowedEnvKinds: ['preview'],
    });
    expect(r.env?.id).toBe('prod');
    expect(r.env?.targetKind).toBe('promoted');
    expect(r.authorized).toBe(false);
  });

  it('resolves by env name (and authorizes) when no PR number is given', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({
        env: envRow({
          id: 'staging',
          name: 'staging',
          is_default: false,
          current_version: 2,
        }),
      }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { envName: 'staging' },
      allowedEnvKinds: ['promoted'],
    });
    expect(r.env?.id).toBe('staging');
    expect(r.authorized).toBe(true);
  });

  it('returns unauthorized when the selector names neither env nor PR', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({ env: envRow() }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: {},
      allowedEnvKinds: ['preview'],
    });
    expect(r).toEqual({ env: null, authorized: false });
  });

  it('returns unauthorized when the env is not found', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({ env: null }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { prNumber: 99 },
      allowedEnvKinds: ['preview'],
    });
    expect(r).toEqual({ env: null, authorized: false });
  });

  it('returns unauthorized on a lookup error', async () => {
    const r = await resolveEnvironmentForSelector({
      supabase: selectorSupabase({ errorMessage: 'boom' }),
      appId: 'app-1',
      tenantId: 'tenant-1',
      selector: { prNumber: 7 },
      allowedEnvKinds: ['preview'],
    });
    expect(r).toEqual({ env: null, authorized: false });
  });
});

describe('resolveIngestEnvironment — header-driven selection vs key pin', () => {
  it('authorizes + returns the selected preview env for a kind-scoped key (PR header)', async () => {
    const env = await resolveIngestEnvironment({
      supabase: selectorSupabase({
        env: envRow({
          id: 'pr-7',
          name: 'pr-7',
          is_default: false,
          current_version: 0,
          is_ephemeral: true,
        }),
      }),
      user: {
        appId: 'app-1',
        tenantId: 'tenant-1',
        apiKeyId: 'k',
        allowedEnvKinds: ['preview'],
      },
      prNumberHeader: '7',
    });
    expect(env?.id).toBe('pr-7');
  });

  it('stamps no env (null) when the selected env kind is not allowed', async () => {
    const env = await resolveIngestEnvironment({
      supabase: selectorSupabase({
        env: envRow({
          id: 'prod',
          name: 'production',
          is_default: false,
          current_version: 5,
        }),
      }),
      user: {
        appId: 'app-1',
        tenantId: 'tenant-1',
        apiKeyId: 'k',
        allowedEnvKinds: ['preview'],
      },
      envNameHeader: 'production',
    });
    expect(env).toBeNull();
  });

  it('falls through to the key pin when the key carries no allowed kinds (even with a selector header)', async () => {
    const env = await resolveIngestEnvironment({
      supabase: selectorSupabase({
        env: envRow({ id: 'pinned', name: 'dev', current_version: 0 }),
      }),
      user: {
        appId: 'app-1',
        tenantId: 'tenant-1',
        apiKeyId: 'k',
        environmentId: 'env-pin',
      },
      prNumberHeader: '7',
    });
    expect(env?.id).toBe('pinned');
  });

  it('uses the pin path when no selector header is present (despite allowed kinds)', async () => {
    const env = await resolveIngestEnvironment({
      supabase: selectorSupabase({
        env: envRow({ id: 'pinned2', name: 'dev', current_version: 0 }),
      }),
      user: {
        appId: 'app-1',
        tenantId: 'tenant-1',
        apiKeyId: 'k',
        environmentId: 'env-pin',
        allowedEnvKinds: ['preview'],
      },
    });
    expect(env?.id).toBe('pinned2');
  });
});
