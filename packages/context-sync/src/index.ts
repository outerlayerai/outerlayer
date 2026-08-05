/**
 * Context mirror sync — package entry point.
 *
 * The caller supplies the concrete ports: a `ContextMirrorPort` (the Supabase
 * impl lives dashboard-side, where the generated db types live) and a `GitPort`
 * (any git provider — the dashboard's `GitProvider` satisfies it structurally).
 *
 * @example
 * ```typescript
 * const contextSync = buildContextSync({
 *   db: createSupabaseContextMirrorPort(createSupabaseAdminClient()),
 *   git: provider,
 * });
 * await contextSync.syncOnPush({ appId, tenantId, repo, branch, beforeSha, afterSha });
 * ```
 */
import { createContextSync } from './sync';
import type { ContextMirrorPort, ContextSync, GitPort } from './types';

export { createContextSync } from './sync';
export type {
  ContextSync,
  ContextMirrorPort,
  GitPort,
  GitTreeEntry,
  FileContent,
  FileDiff,
  SyncOutcome,
  SyncOnPushInput,
  InitialSyncInput,
  ResyncInput,
  EnsureSnapshotAtInput,
  SyncEventInput,
  SyncTrigger,
  SyncEventStatus,
  ContextHeadRecord,
  BlobInput,
  EntryInput,
  CreateSnapshotInput,
  AdvanceHeadInput,
} from './types';

export function buildContextSync(deps: { db: ContextMirrorPort; git: GitPort }): ContextSync {
  return createContextSync(deps);
}
