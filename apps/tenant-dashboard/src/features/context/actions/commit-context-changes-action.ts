"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizedAction } from "../../../lib/action-kit";
import type { ServiceContext } from "../../../lib/action-kit/service-context";
import { checkAppPermission } from "../../../utils/permission-check";
import { Permissions } from "../../../utils/permissions";
import type { Database } from "../../../types/db";
import {
  createGitConnectionPort,
  createMirrorReadPort,
  createPolicyPort,
  commitContextChanges,
  resolveActor,
  type ContextBatchCommitOutcome,
} from "../../../lib/adapters/context-save-write";
import { commitContextChangesSchema, type CommitContextChangesParsed } from "../schemas";

/**
 * Commits a batch of context edits/creates/deletes as ONE commit. The required
 * permissions are composed from the batch itself: an edit (non-null
 * baseBlobSha) requires `context.update`, a create (null baseBlobSha) requires
 * `context.insert`, a delete requires `context.delete`. A batch only ever
 * demands the permissions its own change types call for — a create-only batch
 * never demands update, a delete-only batch never demands insert.
 * `authorizedAction`'s permission is a single static string, so the strictest
 * applicable gate wraps the action (chosen at the call site from the batch);
 * every other applicable permission is checked explicitly here before the
 * service touches git.
 */
function makeCommitHandler(alreadyGated: string) {
  return async (
    ctx: ServiceContext,
    input: CommitContextChangesParsed,
  ): Promise<ContextBatchCommitOutcome> => {
    const hasEdit = input.files.some((file) => !file.delete && file.baseBlobSha !== null);
    const hasCreate = input.files.some((file) => !file.delete && file.baseBlobSha === null);
    const hasDelete = input.files.some((file) => file.delete === true);
    const required = [
      ...(hasEdit ? [Permissions.CONTEXT_UPDATE] : []),
      ...(hasCreate ? [Permissions.CONTEXT_INSERT] : []),
      ...(hasDelete ? [Permissions.CONTEXT_DELETE] : []),
    ];
    // The wrapper's own static gate already covers `alreadyGated`; a mixed
    // batch needs the rest too, checked explicitly before any git work.
    for (const permission of required) {
      if (permission === alreadyGated) continue;
      const check = await checkAppPermission(permission, input.appId);
      if (check.error) throw new Error(check.error);
    }

    const supabase = ctx.db as SupabaseClient<Database>;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");
    return commitContextChanges(
      {
        connection: createGitConnectionPort(supabase),
        policy: createPolicyPort(supabase),
        mirror: createMirrorReadPort(supabase),
      },
      {
        appId: input.appId,
        message: input.message,
        files: input.files,
        actor: resolveActor(user),
      },
    );
  };
}

export const runCommitUpdateFirst = authorizedAction({
  input: commitContextChangesSchema,
  permission: Permissions.CONTEXT_UPDATE,
  appId: (input) => input.appId,
  handler: makeCommitHandler(Permissions.CONTEXT_UPDATE),
});

export const runCommitInsertFirst = authorizedAction({
  input: commitContextChangesSchema,
  permission: Permissions.CONTEXT_INSERT,
  appId: (input) => input.appId,
  handler: makeCommitHandler(Permissions.CONTEXT_INSERT),
});

export const runCommitDeleteFirst = authorizedAction({
  input: commitContextChangesSchema,
  permission: Permissions.CONTEXT_DELETE,
  appId: (input) => input.appId,
  handler: makeCommitHandler(Permissions.CONTEXT_DELETE),
});
