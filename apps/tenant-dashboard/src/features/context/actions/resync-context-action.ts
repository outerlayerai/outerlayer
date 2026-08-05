"use server";

/**
 * Manual "Resync" server action. Gated on `context.read` — it only refreshes
 * what the caller can already read (mirror writes happen under service role
 * internally, same as every other sync path). The check must stay app-scoped,
 * so the `appId` resolver is required.
 *
 * The operation itself needs the service-role client throughout (the mirror,
 * pointer, and PR-backfill writes are admin-authority by design), and
 * `getAdminDataClient` is confined to `src/lib/system/**` — so the work lives
 * in `resyncContext`, a named lib/system function, and this action takes only
 * its outcome.
 */
import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import { resyncContext } from "@/lib/system/context-sync/resync";
import type { ServerActionResponse } from "@/types/server-action";
import type { SyncOutcome } from "@repo/context-sync";
import { resyncContextSchema } from "../schemas";

export const runResyncContext = authorizedAction({
  input: resyncContextSchema,
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: async (_ctx, input): Promise<ServerActionResponse<SyncOutcome>> => {
    return resyncContext(input.appId);
  },
});
