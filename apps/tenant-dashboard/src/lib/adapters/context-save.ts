/**
 * Adapter bridge for the context-save wire types, which the legacy save-service
 * still owns. Type-only, so nothing server-side rides into a client bundle.
 * Collapses when the save/sync pipeline migrates into the feature.
 */
export type {
  ContextSaveResult,
  ContextSaveOutcome,
  ContextBatchFileConflict,
  ContextBatchCommitOutcome,
  SkillDeletionEnumeration,
  SkillDeletionEnumerationOutcome,
} from "@/lib/system/context-save/save-service";
