"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizedAction } from "../../../lib/action-kit";
import { Permissions } from "../../../utils/permissions";
import type { Database } from "../../../types/db";
import {
  createGitConnectionPort,
  createMirrorReadPort,
  createPolicyPort,
  enumerateSkillDeletion,
  type SkillDeletionEnumerationOutcome,
} from "../../../lib/adapters/context-save-write";
import { enumerateSkillDeletionSchema } from "../schemas";

/**
 * Lists every path a skill-directory delete would remove — mirrored content
 * files AND non-mirrored assets/scripts — so the delete confirmation UI can
 * warn BEFORE deleting. Read-only, gated on `context.read` (interaction-
 * triggered, not page-load, so it stays an action rather than a React Server Component (RSC) read).
 */
export const runEnumerateSkillDeletion = authorizedAction({
  input: enumerateSkillDeletionSchema,
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<SkillDeletionEnumerationOutcome> => {
    const supabase = ctx.db as SupabaseClient<Database>;
    return enumerateSkillDeletion(
      {
        connection: createGitConnectionPort(supabase),
        policy: createPolicyPort(supabase),
        mirror: createMirrorReadPort(supabase),
      },
      input.appId,
      input.skillDir,
    );
  },
});
