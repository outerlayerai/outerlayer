import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@/lib/observability/error-reporting/sentry";
import { getRequestDataClient } from "@/lib/system/request-client";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import type { Database } from "@/types/db";
import { ServerActionResponse } from "@/types/server-action";

/**
 * Clear a stale `webhook_id` pointer when disconnecting from a repository.
 * GitHub webhooks are managed by the GitHub App automatically — this only
 * tidies up the DB column left behind by a connection that once carried one.
 */
export async function removeGitWebhook(
  appId: string,
  client?: SupabaseClient<Database>
): Promise<ServerActionResponse | void> {
  // Prefer the caller's already-scoped client (the OAuth callbacks pass the
  // signed-state tenant's client). Absent one, scope to the URL org when the
  // caller carries one (the app-delete cascade), else the JWT claim — /auth/**
  // has no org in the path, so no request tenant exists there.
  const supabase =
    client ?? (await getRequestDataClient(await getRequestTenantId()));

  const { data: connection, error: connectionError } = await supabase
    .from("git_connection")
    .select("webhook_id")
    .eq("app_id", appId)
    .single();

  if (connectionError || !connection?.webhook_id) {
    return;
  }

  try {
    await supabase
      .from("git_connection")
      .update({ webhook_id: null })
      .eq("app_id", appId);
  } catch (error) {
    // best-effort cleanup — surface to Sentry without failing disconnect
    Sentry.captureException(error, {
      extra: { appId, webhookId: connection.webhook_id },
    });
  }
}
