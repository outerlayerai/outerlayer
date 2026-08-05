"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizedAction } from "../../../lib/action-kit";
import { Permissions } from "../../../utils/permissions";
import type { Database } from "../../../types/db";
import {
  createGitConnectionPort,
  createMirrorReadPort,
  createPolicyPort,
  saveContextFile,
  resolveActor,
  type ContextSaveOutcome,
} from "../../../lib/adapters/context-save-write";
import { saveContextFileSchema } from "../schemas";

/**
 * Saves an existing context file. Validate → resolve the URL-tenant context →
 * check the app-scoped `context.update` permission → one service call under the
 * request-tenant RLS client (`ctx.db`), so the write lands under the tenant the
 * check authorized.
 */
export const runSaveContextFile = authorizedAction({
  input: saveContextFileSchema,
  permission: Permissions.CONTEXT_UPDATE,
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<ContextSaveOutcome> => {
    const supabase = ctx.db as SupabaseClient<Database>;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");
    return saveContextFile(
      {
        connection: createGitConnectionPort(supabase),
        policy: createPolicyPort(supabase),
        mirror: createMirrorReadPort(supabase),
      },
      {
        appId: input.appId,
        path: input.path,
        content: input.content,
        baseBlobSha: input.baseBlobSha,
        commitMessage: input.commitMessage,
        actor: resolveActor(user),
      },
    );
  },
});
