import 'server-only';

/**
 * Adapter bridge for the context save-path write pipeline, which the legacy
 * `services/context-save/**` still owns: the service itself, its
 * Supabase-backed port factories, and the actor resolver every write action
 * needs. Server-only (unlike the type-only `context-save.ts` bridge next to
 * this file) — collapses when the save pipeline migrates into the feature.
 */
export {
  saveContextFile,
  commitContextChanges,
  enumerateSkillDeletion,
  type ContextSaveOutcome,
  type ContextBatchCommitOutcome,
  type SkillDeletionEnumerationOutcome,
} from '@/lib/system/context-save/save-service';
// The two outcome types above are also re-exported (type-only) from the
// sibling `context-save.ts` bridge for client-component callers — this
// module carries them too so a server action needs one import, not two.
export {
  createGitConnectionPort,
  createMirrorReadPort,
  createPolicyPort,
} from '@/lib/system/context-save/production-ports';
export { resolveActor } from '@/lib/system/context-save/actor';
