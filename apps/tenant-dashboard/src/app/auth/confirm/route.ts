import { type EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../supabaseServerClient";
import { createSupabaseAdminClient } from "../../../supabaseAdminClient";
import { createEmailService } from "../../../lib/external-services";
import { serverLogger } from "@/lib/observability/server-logger";
import { resolveNextPath, requestAllowedOrigins } from "../../../lib/auth/sanitize-return-to";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // `next` can be a relative path (invite emails) or a full same-origin URL
  // (GoTrue's `{{ .RedirectTo }}` in the signup-confirmation email). It may
  // carry its own query string (e.g. `/auth/accept-invite?id=…`), so resolve
  // path + search together instead of assigning `pathname` directly — and
  // drop the inbound token params so they don't leak into the destination.
  // Behind the proxy the public origin arrives via x-forwarded-host, so a
  // full URL matching either origin counts as ours.
  const next = resolveNextPath(
    searchParams.get("next"),
    requestAllowedOrigins(request.nextUrl.origin, request.headers.get("x-forwarded-host")),
  );
  const nextUrl = new URL(next, request.nextUrl.origin);
  const redirectTo = request.nextUrl.clone();
  redirectTo.pathname = nextUrl.pathname;
  redirectTo.search = nextUrl.search;

  if (token_hash && type) {
    const supabase = await createSupabaseServerClient();

    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash,
    });
    
    if (!error) {
      // If this is an invite confirmation, auto-activate the user's membership and set role claim
      if (type === "invite") {
        try {
          const { data: { user } } = await supabase.auth.getUser();

          if (user) {
            const supabaseAdmin = createSupabaseAdminClient();

            // Find and activate any pending memberships for this user
            const { data: activatedMemberships, error: updateError } = await supabaseAdmin
              .from("membership")
              .update({ status: "active", accepted_at: new Date().toISOString() })
              .eq("user_id", user.id)
              .eq("status", "pending")
              .select("role, tenant_id");

            if (updateError) {
              await serverLogger.error(new Error("Failed to activate membership"), { userId: user.id, updateError: updateError.message });
            } else if (activatedMemberships && activatedMemberships.length > 0) {
              // Accepting an invite is the user's own action to join, so the
              // accepted org becomes their last-active preference — the same
              // treatment a new org gets on creation.
              const membership = activatedMemberships[0]!;
              const { error: preferenceError } = await supabaseAdmin
                .from("profile")
                .update({ last_active_tenant_id: membership.tenant_id })
                .eq("id", user.id);

              if (preferenceError) {
                await serverLogger.error(new Error("Failed to record last-active org"), { userId: user.id, tenantId: membership.tenant_id, preferenceError: preferenceError.message });
              } else {
                await serverLogger.info("Auto-activated membership for invited user", { userId: user.id, tenantId: membership.tenant_id, role: membership.role });
              }
            }
          }
        } catch (membershipError) {
          // Don't fail the confirmation if membership activation fails
          await serverLogger.error(membershipError instanceof Error ? membershipError : new Error("Error activating membership"), { context: "invite-confirm" });
        }
      }

      // If this is an email confirmation (new signup verification), add to broadcast list
      if (type === "email") {
        try {
          const { data: { user } } = await supabase.auth.getUser();

          if (user && user.email) {
            // Extract first and last name from user metadata if available
            const displayName = user.user_metadata?.display_name || "";
            const nameParts = displayName.split(" ");
            const firstName = nameParts[0] || "";
            const lastName = nameParts.slice(1).join(" ") || "";

            // Add to Resend broadcast audience for monthly newsletters
            const emailService = createEmailService();
            const result = await emailService.addToBroadcastAudience(user.email, firstName, lastName);

            if (result.success) {
              await serverLogger.info("Successfully added user to broadcast audience", { email: user.email });
            } else {
              await serverLogger.error(new Error("Failed to add user to broadcast audience"), { email: user.email, audienceError: result.error });
            }
          }
        } catch (audienceError) {
          // Don't fail the confirmation if broadcast list addition fails
          await serverLogger.error(audienceError instanceof Error ? audienceError : new Error("Error adding user to broadcast audience"), { context: "broadcast-audience" });
        }
      }

      return NextResponse.redirect(redirectTo);
    }
  }

  // Verification failed (token consumed or expired). A silent bounce to the
  // login screen reads as "the link did nothing" — common when an invite or
  // confirmation link is clicked a second time — so explain on a dedicated
  // page instead. Requests with no token at all keep the clean login
  // redirect.
  redirectTo.pathname = token_hash && type ? "/auth/link-expired" : "/auth/login";
  redirectTo.search = "";
  return NextResponse.redirect(redirectTo);
}
