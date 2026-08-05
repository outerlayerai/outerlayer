import "server-only";

/**
 * Dashboard-side barrel for the context mirror sync.
 *
 * The algorithm + ports live in `@repo/context-sync` (pure, no Supabase). This
 * barrel re-exports the package's public surface and adds the dashboard-side
 * piece the package intentionally does NOT own: the Supabase
 * `ContextMirrorPort` impl (needs the generated db types). Callers keep
 * importing from `@/lib/system/context-sync`.
 *
 * @example
 * ```typescript
 * const contextSync = buildContextSync({
 *   db: createSupabaseContextMirrorPort(getAdminDataClient()),
 *   git: provider,
 * });
 * await contextSync.syncOnPush({ appId, tenantId, repo, branch, beforeSha, afterSha });
 * ```
 */
export { buildContextSync } from '@repo/context-sync';
export type {
  ContextSync,
  ContextMirrorPort,
  GitPort,
  SyncOutcome,
  SyncOnPushInput,
  InitialSyncInput,
  ResyncInput,
  EnsureSnapshotAtInput,
  SyncEventInput,
} from '@repo/context-sync';

export { createSupabaseContextMirrorPort } from './mirror-port';
