import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { SUPABASE_API } from "../../config-global";
import { paths } from "../../routes/paths";
import {
  extractOrgName,
  resolveRequestTenantId,
} from "../../lib/tenant/request-tenant";

const TENANT_HEADER = "x-tenant-id";

/**
 * API prefixes that authenticate themselves (signature / secret) or serve no
 * tenant data. They must not run session logic — a `getUser()` here would 401 a
 * valid webhook/cron call — but they DO get the inbound `x-tenant-id` stripped.
 * The matcher covers all of `/api/**`; these get ONLY the strip.
 */
function isStripOnlyApiPath(pathname: string): boolean {
  if (pathname === "/api/analytics") return true; // bare uptime probe, public
  const prefixes = [
    "/api/webhooks",
    "/api/cron",
    "/api/health",
    "/api/analytics/health",
  ];
  if (prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  return pathname.startsWith("/api/internal/");
}

/**
 * The CLI authenticates itself over a bearer Supabase JWT, never a session
 * cookie, so it skips the cookie-session block below. Its `x-tenant-id`
 * handling is route-local (resolveCliTenant), so the header passes through
 * on these paths only.
 */
function isCliApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/cli/");
}

// Mirrors ADMIN_API_KEY_PREFIX in lib/system/admin-api-key-service.ts,
// hardcoded rather than imported: that module pulls in Node-only mint/verify
// dependencies this edge-runtime middleware must not carry.
const ADMIN_API_KEY_BEARER_PREFIX = "Bearer olk_";

/**
 * The canonical org-scoped API routes double as the admin-API-key bearer
 * surface. A bearer call carries no session cookie, so it must not hit the
 * cookie-session block below on these paths.
 */
function isAdminApiKeyBearerPath(request: NextRequest): boolean {
  return (
    request.nextUrl.pathname.startsWith("/api/orgs/") &&
    (request.headers.get("authorization") ?? "").startsWith(ADMIN_API_KEY_BEARER_PREFIX)
  );
}

export async function updateSession(request: NextRequest) {
  // Strip any inbound x-tenant-id so the value downstream code reads was minted
  // by this middleware. Self-authenticating / tenant-agnostic api prefixes get
  // ONLY the strip — no session handling — so their behavior is unchanged
  // beyond it.
  if (isStripOnlyApiPath(request.nextUrl.pathname)) {
    const strippedHeaders = new Headers(request.headers);
    strippedHeaders.delete(TENANT_HEADER);
    return NextResponse.next({ request: { headers: strippedHeaders } });
  }

  // No cookie-session handling (the CLI has none): the CLI's own x-tenant-id
  // passes through for resolveCliTenant to handle.
  if (isCliApiPath(request.nextUrl.pathname)) {
    return NextResponse.next({ request });
  }

  // Admin API keys authenticate themselves at the route
  // (`loadBearerServiceContext`), which fails closed on its own — an invalid
  // or unknown key 401s/403s there, never here. A session check here would
  // 401 every bearer call before that verification ever runs, since a bearer
  // caller carries no session cookie. The inbound x-tenant-id is still
  // stripped: a bearer call has no user to resolve membership for, so no
  // tenant header is threaded for it either — the route resolves its own
  // tenant from the URL org.
  if (isAdminApiKeyBearerPath(request)) {
    const strippedHeaders = new Headers(request.headers);
    strippedHeaders.delete(TENANT_HEADER);
    return NextResponse.next({ request: { headers: strippedHeaders } });
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    SUPABASE_API.url,
    SUPABASE_API.key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !request.nextUrl.pathname.startsWith("/auth")) {
    // API routes get a JSON 401, never a login redirect. fetch() silently
    // follows redirects, so redirecting an API call serves the login page
    // HTML with status 200 and the caller blows up parsing it as JSON
    // ("Unexpected token '<'"). Browsers navigating pages still get the
    // redirect below.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({ error: "Not authenticated", code: "UNAUTHORIZED" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        }
      );
    }

    // no user, respond by redirecting the user to the login page
    const url = request.nextUrl.clone();
    url.pathname = paths.auth.login;
    return NextResponse.redirect(url);
  }

  // Note: We intentionally do NOT redirect authenticated users away from auth pages
  // in middleware. The client-side GuestGuard handles this redirect after the auth
  // context fully loads (including memberships). This prevents race conditions where
  // the session isn't fully established yet, which can cause incorrect redirects
  // (e.g., user with orgs being sent to /create-organization).

  // Strip any inbound x-tenant-id, then set the value derived from the URL org
  // for a path the authed user is an active member of. No org in the path or
  // no active membership ⇒ no header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(TENANT_HEADER);

  const orgName = extractOrgName(request.nextUrl.pathname);
  if (orgName && user) {
    const tenantId = await resolveRequestTenantId(supabase, user.id, orgName);
    if (tenantId) {
      requestHeaders.set(TENANT_HEADER, tenantId);
    }
  }

  // Forward the derived header on the request while preserving the session
  // cookies the client refreshed above — the documented safe pattern for
  // returning a new response object from this refresher (copy the cookies over,
  // never mutate them) so the browser and server never fall out of session sync.
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });

  return response;
}
