/**
 * AppsService — tenant isolation + behaviour tests.
 *
 * Apps are the top-level tenant entity, so tenant isolation rests entirely
 * on this service: every query MUST carry `.eq('tenant_id', tenantId)`. The
 * recording mock below records every filter and the assertions at the end
 * of each test verify it. Same pattern as alerts-service.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AppsService,
  AppNotFoundError,
  DuplicateAppNameError,
  GitConnectionMissingError,
  RepoBranchAlreadyLinkedError,
} from '../apps-service';
import type { GitFileProvider } from '../../git/types';

// ---------------------------------------------------------------------------
// Recording mock Supabase (mirrors alerts-service.test.ts)
// ---------------------------------------------------------------------------

interface QueryRecord {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Array<{ column: string; value: unknown }>;
  inserts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  rangeArgs: Array<{ from: number; to: number }>;
}

type TerminalResult = {
  data: unknown;
  error: { message: string; code?: string; details?: string } | null;
  count?: number;
};

function createRecordingSupabase() {
  const queries: QueryRecord[] = [];
  const queued: Record<string, TerminalResult[]> = {};

  function terminalResult(table: string): TerminalResult {
    const stack = queued[table];
    if (stack && stack.length > 0) return stack.shift()!;
    return { data: null, error: null };
  }

  function makeChain(table: string): any {
    const record: QueryRecord = {
      table,
      op: 'select',
      filters: [],
      inserts: [],
      updates: [],
      rangeArgs: [],
    };
    queries.push(record);

    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (payload: Record<string, unknown>) => {
        record.op = 'insert';
        record.inserts.push(payload);
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        record.op = 'update';
        record.updates.push(payload);
        return chain;
      },
      delete: () => {
        record.op = 'delete';
        return chain;
      },
      eq: (column: string, value: unknown) => {
        record.filters.push({ column, value });
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      range: (from: number, to: number) => {
        record.rangeArgs.push({ from, to });
        return chain;
      },
      single: async () => terminalResult(table),
      maybeSingle: async () => terminalResult(table),
      then: (resolve: (v: TerminalResult) => unknown) => {
        return Promise.resolve(terminalResult(table)).then(resolve);
      },
    };
    return chain;
  }

  return {
    client: { from: (table: string) => makeChain(table) } as { from: (t: string) => any },
    queries,
    queue(table: string, result: TerminalResult) {
      if (!queued[table]) queued[table] = [];
      queued[table].push(result);
    },
  };
}

function expectTenantIdFiltered(queries: QueryRecord[], table: string, tenantId: string) {
  const relevant = queries.filter((q) => q.table === table);
  expect(relevant.length, `expected query on "${table}"`).toBeGreaterThan(0);
  for (const q of relevant) {
    const tenantFilter = q.filters.find((f) => f.column === 'tenant_id');
    expect(
      tenantFilter?.value,
      `${q.op} on ${table} missing .eq('tenant_id', '${tenantId}') — possible cross-tenant leak`,
    ).toBe(tenantId);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const APP_1 = '11111111-1111-1111-1111-111111111111';
const USER_X = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const sampleRow = {
  id: APP_1,
  tenant_id: TENANT_A,
  name: 'triage',
  display_name: null,
  runtime: 'nodejs',
  entry_point: null,
  commit_sha: null,
  fly_app_name: null,
  fly_machine_id: null,
  fly_machine_url: null,
  created_at: '2026-05-21T00:00:00Z',
  created_by: USER_X,
  updated_at: null,
  updated_by: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppsService', () => {
  let recorder: ReturnType<typeof createRecordingSupabase>;
  let service: AppsService;

  beforeEach(() => {
    recorder = createRecordingSupabase();
    service = new AppsService(recorder.client as any);
  });

  describe('listApps', () => {
    it('filters by tenant_id and returns mapped rows', async () => {
      recorder.queue('app', { data: [sampleRow], error: null, count: 1 });

      const result = await service.listApps(TENANT_A, { limit: 25, offset: 0 });

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe(APP_1);
      expect(result.data[0]?.runtime).toBe('nodejs');
      expectTenantIdFiltered(recorder.queries, 'app', TENANT_A);
    });

    it('adds the name filter when provided', async () => {
      recorder.queue('app', { data: [sampleRow], error: null, count: 1 });

      await service.listApps(TENANT_A, { name: 'triage', limit: 25, offset: 0 });

      const q = recorder.queries.find((q) => q.table === 'app');
      expect(q?.filters).toContainEqual({ column: 'name', value: 'triage' });
    });

    it('returns empty page on PGRST103 (offset past total)', async () => {
      recorder.queue('app', {
        data: null,
        error: { message: 'range out', code: 'PGRST103' },
        count: 3,
      });

      const result = await service.listApps(TENANT_A, { limit: 25, offset: 1000 });

      expect(result.data).toEqual([]);
      expect(result.total).toBe(3);
    });

    it('throws on other PostgREST errors', async () => {
      recorder.queue('app', {
        data: null,
        error: { message: 'boom', code: '42501' },
      });

      await expect(
        service.listApps(TENANT_A, { limit: 25, offset: 0 }),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('getApp', () => {
    it('throws AppNotFoundError when no row matches', async () => {
      recorder.queue('app', { data: null, error: null });

      await expect(service.getApp(TENANT_A, APP_1)).rejects.toBeInstanceOf(
        AppNotFoundError,
      );
      expectTenantIdFiltered(recorder.queries, 'app', TENANT_A);
    });

    it('returns the mapped row when found', async () => {
      recorder.queue('app', { data: sampleRow, error: null });

      const app = await service.getApp(TENANT_A, APP_1);

      expect(app.id).toBe(APP_1);
      expect(app.tenant_id).toBe(TENANT_A);
    });
  });

  describe('createApp', () => {
    it('inserts a row with tenant_id and defaults runtime to nodejs', async () => {
      recorder.queue('app', { data: sampleRow, error: null });

      const app = await service.createApp(
        TENANT_A,
        { name: 'triage' },
        USER_X,
      );

      expect(app.id).toBe(APP_1);
      const insert = recorder.queries.find((q) => q.op === 'insert');
      expect(insert!.inserts[0]).toMatchObject({
        tenant_id: TENANT_A,
        name: 'triage',
        runtime: 'nodejs',
        created_by: USER_X,
      });
    });

    it('retries with NULL created_by on app_created_by_fkey violation', async () => {
      // First insert fails with FK violation; retry succeeds.
      recorder.queue('app', {
        data: null,
        error: {
          message: 'fk',
          code: '23503',
          details: 'Key (created_by)=... is not in app_created_by_fkey',
        },
      });
      recorder.queue('app', { data: { ...sampleRow, created_by: null }, error: null });

      const app = await service.createApp(TENANT_A, { name: 'triage' }, USER_X);

      expect(app.created_by).toBeNull();
      const inserts = recorder.queries.filter((q) => q.op === 'insert');
      expect(inserts).toHaveLength(2);
      expect(inserts[0]!.inserts[0]).toMatchObject({ created_by: USER_X });
      expect(inserts[1]!.inserts[0]).toMatchObject({ created_by: null });
    });

    it('throws DuplicateAppNameError on unique_name_per_tenant violation', async () => {
      recorder.queue('app', {
        data: null,
        error: {
          message: 'dup',
          code: '23505',
          details: 'Key (tenant_id, name) violates unique_name_per_tenant',
        },
      });

      await expect(
        service.createApp(TENANT_A, { name: 'triage' }, USER_X),
      ).rejects.toBeInstanceOf(DuplicateAppNameError);
    });

    it('passes entry_point through when supplied', async () => {
      recorder.queue('app', { data: sampleRow, error: null });

      await service.createApp(
        TENANT_A,
        { name: 'triage', entry_point: 'src/index.ts' },
        null,
      );

      const insert = recorder.queries.find((q) => q.op === 'insert');
      expect(insert!.inserts[0]).toMatchObject({ entry_point: 'src/index.ts' });
    });

    it('persists display_name when supplied', async () => {
      recorder.queue('app', {
        data: { ...sampleRow, display_name: 'Triage Bot' },
        error: null,
      });

      const app = await service.createApp(
        TENANT_A,
        { name: 'triage', display_name: 'Triage Bot' },
        USER_X,
      );

      expect(app.display_name).toBe('Triage Bot');
      const insert = recorder.queries.find((q) => q.op === 'insert');
      expect(insert!.inserts[0]).toMatchObject({ display_name: 'Triage Bot' });
    });

    it('defaults display_name to NULL when omitted', async () => {
      recorder.queue('app', { data: sampleRow, error: null });

      const app = await service.createApp(TENANT_A, { name: 'triage' }, USER_X);

      expect(app.display_name).toBeNull();
      const insert = recorder.queries.find((q) => q.op === 'insert');
      expect(insert!.inserts[0]).toHaveProperty('display_name', null);
    });
  });

  describe('updateApp', () => {
    it('throws AppNotFoundError when the row does not exist', async () => {
      // getApp called first inside updateApp — return null to trigger 404.
      recorder.queue('app', { data: null, error: null });

      await expect(
        service.updateApp(TENANT_A, APP_1, { name: 'new-name' }, USER_X),
      ).rejects.toBeInstanceOf(AppNotFoundError);
    });

    it('updates only the fields supplied (sparse payload)', async () => {
      // getApp pre-check
      recorder.queue('app', { data: sampleRow, error: null });
      // update terminal
      recorder.queue('app', { data: { ...sampleRow, name: 'renamed' }, error: null });

      const app = await service.updateApp(
        TENANT_A,
        APP_1,
        { name: 'renamed' },
        USER_X,
      );

      expect(app.name).toBe('renamed');
      const update = recorder.queries.find((q) => q.op === 'update');
      // sparse: only name + updated_by, never runtime/entry_point/display_name.
      const payload = update!.updates[0]!;
      expect(payload).toMatchObject({ name: 'renamed', updated_by: USER_X });
      expect(payload).not.toHaveProperty('runtime');
      expect(payload).not.toHaveProperty('entry_point');
      expect(payload).not.toHaveProperty('display_name');
    });

    it('persists display_name when supplied (without touching name)', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('app', {
        data: { ...sampleRow, display_name: 'Triage Bot' },
        error: null,
      });

      const app = await service.updateApp(
        TENANT_A,
        APP_1,
        { display_name: 'Triage Bot' },
        USER_X,
      );

      expect(app.display_name).toBe('Triage Bot');
      const payload = recorder.queries.find((q) => q.op === 'update')!.updates[0]!;
      expect(payload).toMatchObject({
        display_name: 'Triage Bot',
        updated_by: USER_X,
      });
      // Renaming the slug is a separate concern — name must not be touched.
      expect(payload).not.toHaveProperty('name');
    });

    it('clears display_name when null is supplied', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('app', { data: { ...sampleRow, display_name: null }, error: null });

      await service.updateApp(TENANT_A, APP_1, { display_name: null }, USER_X);

      const payload = recorder.queries.find((q) => q.op === 'update')!.updates[0]!;
      // null is an intentional clear — must reach the payload, not be dropped.
      expect(payload).toHaveProperty('display_name', null);
    });

    it('retries with NULL updated_by on app_updated_by_fkey violation', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('app', {
        data: null,
        error: {
          message: 'fk',
          code: '23503',
          details: 'Key (updated_by)=... is not in app_updated_by_fkey',
        },
      });
      recorder.queue('app', { data: { ...sampleRow, updated_by: null }, error: null });

      const app = await service.updateApp(
        TENANT_A,
        APP_1,
        { name: 'renamed' },
        USER_X,
      );

      expect(app.updated_by).toBeNull();
      const updates = recorder.queries.filter((q) => q.op === 'update');
      expect(updates).toHaveLength(2);
    });

    it('throws DuplicateAppNameError on rename collision', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('app', {
        data: null,
        error: {
          message: 'dup',
          code: '23505',
          details: 'unique_name_per_tenant',
        },
      });

      await expect(
        service.updateApp(TENANT_A, APP_1, { name: 'taken' }, USER_X),
      ).rejects.toBeInstanceOf(DuplicateAppNameError);
    });
  });

  describe('getGitConnection', () => {
    it('returns disconnected state when no git_connection row exists', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // app pre-check
      recorder.queue('git_connection', { data: null, error: null });

      const result = await service.getGitConnection(TENANT_A, APP_1);

      expect(result).toEqual({
        connected: false,
        provider: null,
        repository: null,
        branch: null,
        installation_id: null,
      });
    });

    it('returns GitHub connection with installation_id', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // app pre-check
      recorder.queue('git_connection', {
        data: { provider: 'github', repository: 'agentmark/triage', installation_id: 42 },
        error: null,
      });
      recorder.queue('git_branch', { data: { branch_name: 'main' }, error: null });

      const result = await service.getGitConnection(TENANT_A, APP_1);

      expect(result).toEqual({
        connected: true,
        provider: 'github',
        repository: 'agentmark/triage',
        branch: 'main',
        installation_id: 42,
      });
    });

    it('reports a legacy connection row as connected even with null installation_id and a non-github provider value', async () => {
      // A git_connection row is "connected" once it exists, independent of
      // installation_id or the provider value it carries — the schema still
      // allows a legacy row shape, and this derivation echoes it verbatim
      // rather than assuming every row is a GitHub install.
      recorder.queue('app', { data: sampleRow, error: null });
      recorder.queue('git_connection', {
        data: { provider: 'gitlab', repository: null, installation_id: null },
        error: null,
      });
      recorder.queue('git_branch', { data: null, error: { code: 'PGRST116', message: 'no rows' } });

      const result = await service.getGitConnection(TENANT_A, APP_1);

      expect(result.connected).toBe(true);
      expect(result.provider).toBe('gitlab');
      expect(result.installation_id).toBeNull();
      // OAuth done but no repo picked yet — that's a real state.
      expect(result.repository).toBeNull();
    });

    it('throws AppNotFoundError when the app does not exist (404 not silent)', async () => {
      // Prevents a stale-appId poller from getting `connected: false`
      // forever instead of an actionable 404.
      recorder.queue('app', { data: null, error: null });

      await expect(service.getGitConnection(TENANT_A, APP_1)).rejects.toBeInstanceOf(
        AppNotFoundError,
      );
    });
  });

  describe('deleteApp', () => {
    it('throws AppNotFoundError when the row does not exist', async () => {
      recorder.queue('app', { data: null, error: null });

      await expect(service.deleteApp(TENANT_A, APP_1)).rejects.toBeInstanceOf(
        AppNotFoundError,
      );
    });

    it('deletes the row scoped by tenant_id', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('app', { data: null, error: null }); // delete

      await service.deleteApp(TENANT_A, APP_1);

      const del = recorder.queries.find((q) => q.op === 'delete');
      expect(del?.table).toBe('app');
      expectTenantIdFiltered(recorder.queries, 'app', TENANT_A);
    });
  });

  describe('linkRepository', () => {
    /**
     * Build a stub GitFileProvider where every method is a controllable
     * Promise. Only `getLatestCommitSha` matters for the link flow; the
     * others throw if called (catches accidental reliance on listing
     * during link, which we deliberately don't do for performance).
     */
    function stubProvider(opts: { commitSha?: string | null; shaThrows?: boolean } = {}): GitFileProvider {
      return {
        async listRepositories() {
          throw new Error('listRepositories should not be called during link');
        },
        async listBranches() {
          throw new Error('listBranches should not be called during link');
        },
        async getLatestCommitSha() {
          if (opts.shaThrows) throw new Error('boom');
          return opts.commitSha ?? null;
        },
        async streamFile() {
          throw new Error('streamFile should not be called during link');
        },
      };
    }

    it('throws AppNotFoundError when the app does not exist', async () => {
      recorder.queue('app', { data: null, error: null });

      await expect(
        service.linkRepository(
          TENANT_A,
          APP_1,
          { repository: 'acme/triage', branch: 'main' },
          stubProvider(),
        ),
      ).rejects.toBeInstanceOf(AppNotFoundError);
    });

    it('throws GitConnectionMissingError when no git_connection row exists', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: null, error: null });

      await expect(
        service.linkRepository(
          TENANT_A,
          APP_1,
          { repository: 'acme/triage', branch: 'main' },
          stubProvider(),
        ),
      ).rejects.toBeInstanceOf(GitConnectionMissingError);
    });

    it('writes git_connection.repository, inserts git_branch on fresh app, and seeds commit_sha', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null }); // connection exists
      recorder.queue('git_connection', { data: null, error: null }); // update
      recorder.queue('git_branch', { data: null, error: null }); // existing branch lookup
      recorder.queue('git_branch', { data: { id: 'branch-uuid' }, error: null }); // insert returns id
      recorder.queue('app', { data: null, error: null }); // commit_sha update

      const result = await service.linkRepository(
        TENANT_A,
        APP_1,
        { repository: 'acme/triage', branch: 'main' },
        stubProvider({ commitSha: 'abc123' }),
      );

      expect(result).toEqual({
        repository: 'acme/triage',
        branch: 'main',
        branch_id: 'branch-uuid',
        commit_sha: 'abc123',
      });

      // git_connection update with the exact repo, scoped to app_id
      const connUpdate = recorder.queries.find(
        (q) => q.table === 'git_connection' && q.op === 'update',
      );
      expect(connUpdate?.updates).toEqual([{ repository: 'acme/triage' }]);
      expect(connUpdate?.filters.find((f) => f.column === 'app_id')?.value).toBe(APP_1);

      // git_branch insert with tenant_id (defense in depth — the row
      // also gets RLS but we shouldn't rely on RLS to set the tenant).
      const branchInsert = recorder.queries.find(
        (q) => q.table === 'git_branch' && q.op === 'insert',
      );
      expect(branchInsert?.inserts[0]).toMatchObject({
        app_id: APP_1,
        tenant_id: TENANT_A,
        branch_name: 'main',
        repo: 'acme/triage',
      });

      // commit_sha got seeded
      const appUpdate = recorder.queries.find(
        (q) => q.table === 'app' && q.op === 'update',
      );
      expect(appUpdate?.updates).toEqual([{ commit_sha: 'abc123' }]);
    });

    it('updates existing git_branch row instead of inserting when one exists', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // update
      recorder.queue('git_branch', { data: { id: 'existing-branch-id' }, error: null }); // existing
      recorder.queue('git_branch', { data: null, error: null }); // update
      recorder.queue('app', { data: null, error: null }); // commit_sha

      const result = await service.linkRepository(
        TENANT_A,
        APP_1,
        { repository: 'acme/triage', branch: 'feature/x' },
        stubProvider({ commitSha: 'def456' }),
      );

      expect(result.branch_id).toBe('existing-branch-id');

      const branchUpdate = recorder.queries.find(
        (q) => q.table === 'git_branch' && q.op === 'update',
      );
      expect(branchUpdate?.updates).toEqual([
        { branch_name: 'feature/x', repo: 'acme/triage' },
      ]);

      const branchInsert = recorder.queries.find(
        (q) => q.table === 'git_branch' && q.op === 'insert',
      );
      expect(branchInsert).toBeUndefined();
    });

    it('retries git_branch insert with created_by=null when userId has no profile row', async () => {
      // Regression test for the FK bug surfaced by the live HTTP smoke:
      // git_branch.created_by defaults to auth.uid() which resolves to
      // the gateway system user id under API-key auth — that id has no
      // profile row → git_branch_created_by_fkey violation → 500.
      // The service retries with created_by=null on this specific FK code.
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // update repository
      recorder.queue('git_branch', { data: null, error: null }); // existing-branch lookup
      // First insert attempt: FK violation on created_by.
      recorder.queue('git_branch', {
        data: null,
        error: {
          code: '23503',
          message: 'insert or update on table "git_branch" violates foreign key constraint "git_branch_created_by_fkey"',
          details: 'Key is not present in table "profile".',
        },
      });
      // Retry with created_by=null: succeeds.
      recorder.queue('git_branch', { data: { id: 'retry-branch' }, error: null });

      const result = await service.linkRepository(
        TENANT_A,
        APP_1,
        { repository: 'acme/triage', branch: 'main' },
        // Stub provider — commitSha aux fetch returns null so we don't
        // queue an additional 'app' result for the seed update.
        {
          listRepositories: async () => { throw new Error('unreachable'); },
          listBranches: async () => { throw new Error('unreachable'); },
          getLatestCommitSha: async () => null,
          streamFile: async () => { throw new Error('unreachable'); },
        },
        'system-user-no-profile',
      );

      expect(result.branch_id).toBe('retry-branch');

      // Two inserts attempted: first with created_by=userId, retry with null.
      const branchInserts = recorder.queries.filter(
        (q) => q.table === 'git_branch' && q.op === 'insert',
      );
      expect(branchInserts).toHaveLength(2);
      expect((branchInserts[0]!.inserts[0] as { created_by?: string | null }).created_by).toBe(
        'system-user-no-profile',
      );
      expect((branchInserts[1]!.inserts[0] as { created_by?: string | null }).created_by).toBeNull();
    });

    it('still succeeds when commit_sha lookup fails (link is not blocked on aux fetches)', async () => {
      recorder.queue('app', { data: sampleRow, error: null });
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null });
      recorder.queue('git_branch', { data: null, error: null });
      recorder.queue('git_branch', { data: { id: 'b1' }, error: null });
      // No app-update queued — we shouldn't try to update commit_sha when it's null.

      const result = await service.linkRepository(
        TENANT_A,
        APP_1,
        { repository: 'acme/triage', branch: 'main' },
        stubProvider({ commitSha: null }),
      );

      expect(result.commit_sha).toBeNull();
      const appUpdate = recorder.queries.find(
        (q) => q.table === 'app' && q.op === 'update',
      );
      expect(appUpdate).toBeUndefined();
    });

    it('throws RepoBranchAlreadyLinkedError when the git_branch update hits unique_git_repo_branch_constraint', async () => {
      // Re-link path: the app already has a git_branch row, and the
      // requested repo+branch is watched by ANOTHER app in the tenant.
      // `UNIQUE (repo, branch_name, tenant_id)` fires on the update.
      // Before the mapping this surfaced as a raw PostgrestError → the
      // route's catch-all 500 "Internal server error".
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // repository update
      recorder.queue('git_branch', { data: { id: 'existing-branch-id' }, error: null }); // existing row
      recorder.queue('git_branch', {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "unique_git_repo_branch_constraint"',
          details: 'Key (repo, branch_name, tenant_id)=(acme/triage, main, 00000000-0000-0000-0000-00000000000a) already exists.',
        },
      });

      await expect(
        service.linkRepository(
          TENANT_A,
          APP_1,
          { repository: 'acme/triage', branch: 'main' },
          stubProvider({ commitSha: null }),
        ),
      ).rejects.toBeInstanceOf(RepoBranchAlreadyLinkedError);
    });

    it('throws RepoBranchAlreadyLinkedError when the git_branch insert hits unique_git_repo_branch_constraint', async () => {
      // First-link path: no git_branch row for this app yet, but the
      // repo+branch is already watched by another app in the tenant.
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // repository update
      recorder.queue('git_branch', { data: null, error: null }); // existing-branch lookup: none
      recorder.queue('git_branch', {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "unique_git_repo_branch_constraint"',
          details: 'Key (repo, branch_name, tenant_id)=(acme/triage, main, 00000000-0000-0000-0000-00000000000a) already exists.',
        },
      });

      await expect(
        service.linkRepository(
          TENANT_A,
          APP_1,
          { repository: 'acme/triage', branch: 'main' },
          stubProvider({ commitSha: null }),
        ),
      ).rejects.toBeInstanceOf(RepoBranchAlreadyLinkedError);

      // The unique violation must NOT trigger the created_by FK retry —
      // exactly one insert attempt.
      const branchInserts = recorder.queries.filter(
        (q) => q.table === 'git_branch' && q.op === 'insert',
      );
      expect(branchInserts).toHaveLength(1);
    });

    it('rethrows non-unique-violation git_branch update errors raw (no false 409)', async () => {
      // A transient/unknown DB error on the branch update must surface as
      // itself (→ catch-all 500 + Sentry-worthy log), NOT be misreported
      // to the user as "branch already linked to another app".
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // repository update
      recorder.queue('git_branch', { data: { id: 'existing-branch-id' }, error: null }); // existing row
      const dbError = {
        code: '57P01',
        message: 'terminating connection due to administrator command',
        details: '',
      };
      recorder.queue('git_branch', { data: null, error: dbError });

      await expect(
        service.linkRepository(
          TENANT_A,
          APP_1,
          { repository: 'acme/triage', branch: 'main' },
          stubProvider({ commitSha: null }),
        ),
      ).rejects.toEqual(dbError);
    });

    it('rethrows non-unique-violation git_branch insert errors raw (no false 409)', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1, provider: 'github' }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // repository update
      recorder.queue('git_branch', { data: null, error: null }); // existing-branch lookup: none
      const dbError = {
        code: '57P01',
        message: 'terminating connection due to administrator command',
        details: '',
      };
      recorder.queue('git_branch', { data: null, error: dbError });

      await expect(
        service.linkRepository(
          TENANT_A,
          APP_1,
          { repository: 'acme/triage', branch: 'main' },
          stubProvider({ commitSha: null }),
        ),
      ).rejects.toEqual(dbError);
    });
  });

  describe('unlinkRepository', () => {
    it('throws AppNotFoundError when the row does not exist', async () => {
      recorder.queue('app', { data: null, error: null });

      await expect(service.unlinkRepository(TENANT_A, APP_1)).rejects.toBeInstanceOf(
        AppNotFoundError,
      );
    });

    it('throws GitConnectionMissingError when no git_connection exists', async () => {
      recorder.queue('app', { data: sampleRow, error: null });
      recorder.queue('git_connection', { data: null, error: null });

      await expect(service.unlinkRepository(TENANT_A, APP_1)).rejects.toBeInstanceOf(
        GitConnectionMissingError,
      );
    });

    it('clears git_connection.repository and deletes git_branch row', async () => {
      recorder.queue('app', { data: sampleRow, error: null }); // getApp
      recorder.queue('git_connection', { data: { app_id: APP_1 }, error: null });
      recorder.queue('git_connection', { data: null, error: null }); // update
      recorder.queue('git_branch', { data: null, error: null }); // delete

      await service.unlinkRepository(TENANT_A, APP_1);

      const connUpdate = recorder.queries.find(
        (q) => q.table === 'git_connection' && q.op === 'update',
      );
      expect(connUpdate?.updates).toEqual([{ repository: null }]);

      const branchDel = recorder.queries.find(
        (q) => q.table === 'git_branch' && q.op === 'delete',
      );
      expect(branchDel?.table).toBe('git_branch');
      expect(branchDel?.filters.find((f) => f.column === 'app_id')?.value).toBe(APP_1);
    });
  });
});
