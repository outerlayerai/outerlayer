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
import { createContextFileSchema } from "../schemas";

/**
 * Creates a new context file. Gated on `context.insert`; the path must not
 * already exist at the connected branch's head — a collision comes back as
 * `{ status: 'conflict', reason: 'exists' }`, never a silent overwrite. The
 * `null` base blob sha is what marks the save a create.
 */
export const runCreateContextFile = authorizedAction({
  input: createContextFileSchema,
  permission: Permissions.CONTEXT_INSERT,
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
        baseBlobSha: null,
        commitMessage: input.commitMessage,
        actor: resolveActor(user),
      },
    );
  },
});
