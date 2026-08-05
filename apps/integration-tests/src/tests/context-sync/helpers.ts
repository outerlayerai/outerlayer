/**
 * Shared fixtures for the context-sync integration suite.
 *
 * The git provider is faked at the port boundary (`@repo/context-sync`'s
 * `GitPort`): an in-memory repo tree + file contents, with per-method failure
 * injection. No real GitHub/GitLab calls. Everything below the port — the
 * Supabase mirror (`createSupabaseContextMirrorPort`), the SQL snapshot RPC,
 * the `context_sync_event` ledger, and `advanceCommitPointers` — is the real
 * dashboard code running against a real (worktree) Postgres.
 */
import { randomUUID } from 'crypto';
import type { SupabaseAdminClient } from '../../lib/supabase-admin';
import type {
  FileContent,
  FileDiff,
  GitPort,
  GitTreeEntry,
} from '@repo/context-sync';

// ---------------------------------------------------------------------------
// Fake git port
// ---------------------------------------------------------------------------

type FakeGitMethod =
  | 'getLatestCommitSha'
  | 'listTree'
  | 'getFileContent'
  | 'compareCommits';

export interface FakeGitConfig {
  /** getLatestCommitSha result (branch-ref resolution). `null` = branch gone. */
  headSha?: string | null;
  /** path -> UTF-8 content. Drives both the tree listing and getFileContent. */
  files?: Record<string, string>;
  /** Optional explicit blob sha per content path (defaults to `blob-<path>`). */
  blobShas?: Record<string, string>;
  /** Tree paths present in git but never fetched (excluded assets / ignored files). */
  extraTreePaths?: GitTreeEntry[];
  /** compareCommits result (incremental push path). */
  diffs?: FileDiff[];
  /** Make one port method throw, to drive the failure pins. */
  failOn?: FakeGitMethod;
  failMessage?: string;
}

/**
 * A `GitPort` backed by an in-memory tree. Also structurally satisfies the
 * slice of `GitProvider` the push core touches, so the mocked provider classes
 * in the route tests can delegate straight to it.
 */
export function createFakeGit(cfg: FakeGitConfig): GitPort {
  const files = cfg.files ?? {};
  const blobShaFor = (path: string) => cfg.blobShas?.[path] ?? `blob-${path}`;

  const fail = (m: FakeGitMethod) => {
    if (cfg.failOn === m) {
      throw new Error(cfg.failMessage ?? `fake git: ${m} failed`);
    }
  };

  const tree = (): GitTreeEntry[] => [
    ...Object.entries(files).map(([path, content]) => ({
      path,
      sha: blobShaFor(path),
      size: Buffer.byteLength(content, 'utf-8'),
    })),
    ...(cfg.extraTreePaths ?? []),
  ];

  return {
    async getLatestCommitSha(): Promise<string | null> {
      fail('getLatestCommitSha');
      return cfg.headSha === undefined ? 'sha-head' : cfg.headSha;
    },
    async listTree(): Promise<GitTreeEntry[]> {
      fail('listTree');
      return tree();
    },
    async getFileContent(_repo: string, path: string): Promise<FileContent> {
      fail('getFileContent');
      const content = files[path];
      if (content === undefined) {
        throw new Error(`fake git: no content seeded for ${path}`);
      }
      return {
        path,
        content,
        sha: blobShaFor(path),
        size: Buffer.byteLength(content, 'utf-8'),
        encoding: 'utf-8',
      };
    },
    async compareCommits(): Promise<FileDiff[]> {
      fail('compareCommits');
      return cfg.diffs ?? [];
    },
  };
}

/** A file diff for the incremental-push fake (compareCommits result). */
export function fileDiff(
  path: string,
  status: FileDiff['status'],
  extra?: Partial<FileDiff>,
): FileDiff {
  return {
    path,
    status,
    additions: 1,
    deletions: 0,
    sha: `blob-${path}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

export interface SeededApp {
  tenantId: string;
  appId: string;
  defaultEnvId: string;
}

/** Insert a tenant row. `created_by` carries no auth FK at insert time. */
export async function seedTenant(admin: SupabaseAdminClient): Promise<string> {
  const tenantId = randomUUID();
  const tag = tenantId.slice(0, 8);
  const { error } = await admin.from('tenant').insert({
    tenant_id: tenantId,
    company_name: `ctx-co-${tag}`,
    organization_name: `ctx-org-${tag}`,
    created_by: randomUUID(),
  });
  if (error) throw new Error(`seedTenant: ${error.message}`);
  return tenantId;
}

/**
 * Insert an app and resolve its trigger-seeded default env. The
 * `on_create_seed_default_env` trigger creates the default env in the same
 * transaction, so we just read it back.
 */
export async function seedApp(
  admin: SupabaseAdminClient,
  tenantId: string,
  name?: string,
): Promise<SeededApp> {
  const { data: app, error } = await admin
    .from('app')
    .insert({ tenant_id: tenantId, name: name ?? `ctx-app-${randomUUID().slice(0, 8)}` })
    .select('id')
    .single();
  if (error || !app) throw new Error(`seedApp: ${error?.message ?? 'no row'}`);

  const { data: env, error: envError } = await admin
    .from('environment')
    .select('id')
    .eq('app_id', app.id)
    .eq('is_default', true)
    .single();
  if (envError || !env) throw new Error(`seedApp: default env: ${envError?.message ?? 'none'}`);

  return { tenantId, appId: app.id, defaultEnvId: env.id };
}

/** Insert a non-default env — used to prove pointer advance is default-scoped. */
export async function seedNonDefaultEnv(
  admin: SupabaseAdminClient,
  { tenantId, appId, name }: { tenantId: string; appId: string; name: string },
): Promise<string> {
  const { data, error } = await admin
    .from('environment')
    .insert({ tenant_id: tenantId, app_id: appId, name, is_default: false })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seedNonDefaultEnv: ${error?.message ?? 'no row'}`);
  return data.id;
}

export async function seedGitConnection(
  admin: SupabaseAdminClient,
  args: {
    tenantId: string;
    appId: string;
    repository: string;
    provider: 'github' | 'gitlab';
    webhookSecret?: string;
  },
): Promise<void> {
  const { error } = await admin.from('git_connection').insert({
    tenant_id: args.tenantId,
    app_id: args.appId,
    provider: args.provider,
    repository: args.repository,
    webhook_secret: args.webhookSecret,
  });
  if (error) throw new Error(`seedGitConnection: ${error.message}`);
}

export async function seedGitBranch(
  admin: SupabaseAdminClient,
  args: { tenantId: string; appId: string; branch: string },
): Promise<void> {
  const { error } = await admin.from('git_branch').insert({
    tenant_id: args.tenantId,
    app_id: args.appId,
    branch_name: args.branch,
  });
  if (error) throw new Error(`seedGitBranch: ${error.message}`);
}

/** Delete every row this suite creates for a tenant, children first. */
export async function cleanupTenant(
  admin: SupabaseAdminClient,
  tenantId: string,
): Promise<void> {
  const { data: apps } = await admin.from('app').select('id').eq('tenant_id', tenantId);
  const appIds = (apps ?? []).map((a) => a.id);
  if (appIds.length > 0) {
    await admin.from('context_sync_event').delete().in('app_id', appIds);
    await admin.from('context_head').delete().in('app_id', appIds);
    await admin.from('context_tree_entry').delete().in('app_id', appIds);
    await admin.from('context_blob').delete().in('app_id', appIds);
    await admin.from('context_snapshot').delete().in('app_id', appIds);
    await admin.from('git_branch').delete().in('app_id', appIds);
    await admin.from('git_connection').delete().in('app_id', appIds);
    await admin.from('environment').delete().in('app_id', appIds);
    await admin.from('app').delete().in('id', appIds);
  }
  await admin.from('tenant').delete().eq('tenant_id', tenantId);
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function readSyncEvents(admin: SupabaseAdminClient, appId: string) {
  const { data, error } = await admin
    .from('context_sync_event')
    .select('*')
    .eq('app_id', appId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`readSyncEvents: ${error.message}`);
  return data ?? [];
}

export async function readHead(admin: SupabaseAdminClient, appId: string) {
  const { data } = await admin
    .from('context_head')
    .select('branch, commit_sha, snapshot_id')
    .eq('app_id', appId)
    .maybeSingle();
  return data;
}

export async function readPointers(admin: SupabaseAdminClient, appId: string) {
  const { data: app } = await admin.from('app').select('commit_sha').eq('id', appId).single();
  const { data: envs } = await admin
    .from('environment')
    .select('id, is_default, current_commit_sha')
    .eq('app_id', appId);
  return { appCommitSha: app?.commit_sha ?? null, envs: envs ?? [] };
}
