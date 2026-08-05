import type { ServerActionResponse } from "../../types/server-action";
// Imported from the dependency-free result module, NOT the action-kit barrel:
// this file is part of a Client Component's import graph, and the barrel pulls
// the wrapper's server-only dependencies (request context, Supabase server
// client) into the client bundle, which breaks the production build.
import { ActionErrorCodes } from "../../lib/action-kit/result";
import type {
  ContextSaveOutcome,
  ContextBatchCommitOutcome,
  SkillDeletionEnumerationOutcome,
} from "../../lib/adapters/context-save";

import { runEnumerateSkillDeletion } from "./actions/enumerate-skill-deletion-action";
import { runSaveContextFile } from "./actions/save-context-file-action";
import { runCreateContextFile } from "./actions/create-context-file-action";
import {
  runCommitUpdateFirst,
  runCommitInsertFirst,
  runCommitDeleteFirst,
} from "./actions/commit-context-changes-action";
import { runReadRemoteContextFile, type RemoteContextFile } from "./actions/read-remote-context-file-action";
import {
  runCheckPendingPullRequests,
  type PendingPullRequestsCheck,
} from "./actions/check-pending-pull-requests-action";
import { runResyncContext } from "./actions/resync-context-action";
import type { SyncOutcome } from "@repo/context-sync";

/**
 * Client-facing adapters over the context server actions. Each raw action
 * resolves to an `authorizedAction` envelope carrying the tenancy/permission/
 * validation outcome; these adapters flatten that envelope into the plain
 * `ServerActionResponse` shape the context UI renders, so a caller awaits one
 * call and branches on `data`/`error` instead of unwrapping the envelope
 * itself.
 */

export async function enumerateSkillDeletionAction(
  appId: string,
  skillDir: string,
): Promise<ServerActionResponse<SkillDeletionEnumerationOutcome>> {
  const result = await runEnumerateSkillDeletion({ appId, skillDir });
  if (!result.ok) return { error: result.error.message };
  return { data: result.data };
}

export interface SaveContextFileInput {
  path: string;
  content: string;
  /** Blob sha the editor was opened at — a mismatch at save time is a conflict. */
  baseBlobSha: string;
  /** Defaults to `context: update <kind> <name>` when omitted. */
  commitMessage?: string;
}

export async function saveContextFileAction(
  appId: string,
  input: SaveContextFileInput,
): Promise<ServerActionResponse<ContextSaveOutcome>> {
  const result = await runSaveContextFile({ appId, ...input });
  if (!result.ok) return { error: result.error.message };
  return { data: result.data };
}

export interface CreateContextFileInput {
  path: string;
  content: string;
  /** Defaults to `context: create <kind> <name>` when omitted. */
  commitMessage?: string;
}

export async function createContextFileAction(
  appId: string,
  input: CreateContextFileInput,
): Promise<ServerActionResponse<ContextSaveOutcome>> {
  const result = await runCreateContextFile({ appId, ...input });
  if (!result.ok) return { error: result.error.message };
  return { data: result.data };
}

interface CommitContextChangesInput {
  message?: string;
  files: Array<{
    path: string;
    content: string;
    /** `null` for a newly created file (create), the pinned blob sha otherwise (update/delete). */
    baseBlobSha: string | null;
    /** `true` stages a deletion of `path` (content ignored, baseBlobSha is the conflict base). */
    delete?: boolean;
  }>;
}

export async function commitContextChangesAction(
  appId: string,
  input: CommitContextChangesInput,
): Promise<ServerActionResponse<ContextBatchCommitOutcome>> {
  const hasEdit = input.files.some((file) => !file.delete && file.baseBlobSha !== null);
  const hasCreate = input.files.some((file) => !file.delete && file.baseBlobSha === null);
  const hasDelete = input.files.some((file) => file.delete === true);
  // Gate on the strictest applicable permission first (the handler re-checks
  // every permission the batch actually needs): edit present → update; else
  // create present → insert; else delete present → delete; an empty batch
  // (no change types at all) falls back to update as a harmless default so
  // there is always an auth context.
  const run = hasEdit
    ? runCommitUpdateFirst
    : hasCreate
      ? runCommitInsertFirst
      : hasDelete
        ? runCommitDeleteFirst
        : runCommitUpdateFirst;
  const result = await run({ appId, message: input.message, files: input.files });
  if (!result.ok) {
    // A schema rejection (e.g. the batch-size cap) has no per-draft path to
    // key a `validation_error` outcome's `fileErrors` against — the dialog
    // only highlights rows by path, so a synthetic "(files)" path would match
    // nothing and render as an unexplained "fix the highlighted files". The
    // plain error path surfaces the real message in the dialog's error Alert
    // instead.
    const message =
      result.error.code === ActionErrorCodes.VALIDATION
        ? (result.error.fieldErrors?.files?.[0] ?? result.error.message)
        : result.error.message;
    return { error: message };
  }
  return { data: result.data };
}

export async function readRemoteContextFileAction(
  appId: string,
  path: string,
): Promise<ServerActionResponse<RemoteContextFile>> {
  const result = await runReadRemoteContextFile({ appId, path });
  if (!result.ok) return { error: result.error.message };
  return result.data;
}

export async function checkPendingPullRequestsAction(
  appId: string,
  prNumbers: number[],
): Promise<ServerActionResponse<PendingPullRequestsCheck>> {
  if (prNumbers.length === 0) return { data: { decided: [] } };
  const result = await runCheckPendingPullRequests({ appId, prNumbers });
  if (!result.ok) return { error: result.error.message };
  return { data: result.data };
}

export async function resyncContextAction(appId: string): Promise<ServerActionResponse<SyncOutcome>> {
  const result = await runResyncContext({ appId });
  if (!result.ok) return { error: result.error.message };
  return result.data;
}
