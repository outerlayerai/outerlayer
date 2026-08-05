import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../supabaseServerClient";
import { redirect } from "next/navigation";
import { paths } from "../../../../routes/paths";
import { removeGitWebhook } from "@/lib/system/git/remove-git-webhook";
import { upsertGitConnection } from "@/features/git-connection/service";
import { OAUTH_STATE_SECRET } from "@/config-global.server";
import {
  looksLikeSignedGitConnectState,
  verifySignedGitConnectState,
} from "@/lib/git-connect/verify-state";
import { captureActivationEvent } from "@/lib/posthog-server";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    return NextResponse.json({ error: userError.message });
  }

  if (!user) {
    return NextResponse.json({ error: "User not found" });
  }

  // The signed state below covers the app and tenant; `installation_id` rides
  // outside it, so it is validated on its own. `Number()` of an arbitrary
  // string yields NaN, which must not reach an INT column.
  const rawInstallationId = request.nextUrl.searchParams.get("installation_id");
  const installationId = Number(rawInstallationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    console.error("[github-oauth] missing or malformed installation_id");
    return NextResponse.redirect(
      new URL("/auth/login?error=invalid_installation", request.nextUrl.origin),
    );
  }

  const state = request.nextUrl.searchParams.get("state");

  // The connect flow accepts only the HMAC-signed state minted by the gateway
  // (POST /v1/apps/:appId/git/connect). Anything else — a stale unsigned URL, a
  // forged token — is rejected with an opaque 400.
  if (!looksLikeSignedGitConnectState(state)) {
    console.error("[github-oauth] unsigned state rejected");
    return NextResponse.redirect(
      new URL("/auth/login?error=invalid_oauth_state", request.nextUrl.origin),
    );
  }

  const verified = await verifySignedGitConnectState({
    secret: OAUTH_STATE_SECRET,
    token: state!,
  });
  if (!verified.ok) {
    // Opaque 400 — no leak of which check failed (signature vs expiry
    // vs structure). Logged at error level so ops can correlate.
    console.error("[github-oauth] signed state rejected", { reason: verified.reason });
    return NextResponse.redirect(
      new URL("/auth/login?error=invalid_oauth_state", request.nextUrl.origin),
    );
  }
  if (verified.payload.provider !== "github") {
    // A state minted for a different provider arrived at the GitHub
    // callback — reject. (The OAuth provider can't have done this on
    // its own; it implies a copy-pasted URL or a forged token.)
    console.error("[github-oauth] state provider != github", {
      stateProvider: verified.payload.provider,
    });
    return NextResponse.redirect(
      new URL("/auth/login?error=invalid_oauth_state", request.nextUrl.origin),
    );
  }
  const appId = verified.payload.app_id;

  // The tenant comes from the HMAC-signed state (server secret, unforgeable).
  // The header client makes public.tenant_id() answer with it, so
  // set_tenant_id() stamps the row with that tenant and RLS admits it only for
  // a member — a foreign-tenant state writes nothing.
  const tenantId = verified.payload.tenant_id;
  const db = await createSupabaseServerClient(tenantId);

  // The tenant read policy admits every org the actor is a member of, so a
  // multi-org user's `.single()` needs an explicit tenant filter — resolve the
  // redirect org-name by the state tenant.
  const { data: tenant, error: tenantError } = await db
    .from("tenant")
    .select("organization_name")
    .eq("tenant_id", tenantId)
    .single();
  const { error: appError } = await db
    .from("app")
    .select("name")
    .eq("id", appId)
    .single();

  if (tenantError || appError) {
    return NextResponse.json({ error: tenantError || appError });
  }

  // Clear any webhook_id left behind by a previous connection before this one.
  await removeGitWebhook(appId, db);

  const { error } = await upsertGitConnection(db, {
    appId,
    provider: "github",
    installationId,
  });

  if (error) {
    // 23P01 on the installation exclusion constraint: an installation belongs
    // to one tenant, and this one is already claimed by a different tenant.
    // Logged rather than returned as a routine error so the rejection is
    // visible to operators.
    if (error.code === "23P01") {
      console.error("[github-oauth] installation already connected elsewhere", {
        app_id: appId,
        tenant_id: tenantId,
        installation_id: installationId,
      });
      return NextResponse.redirect(
        new URL(
          "/auth/login?error=installation_already_connected",
          request.nextUrl.origin,
        ),
      );
    }
    return NextResponse.json({ error: error });
  }

  /* c8 ignore next 4 */
  void captureActivationEvent('org_repo_connected', user.id, tenantId, {
    provider: 'github',
    app_id: appId,
  });

  return redirect(paths.orgs.org.apps.root(tenant?.organization_name as string));
}
