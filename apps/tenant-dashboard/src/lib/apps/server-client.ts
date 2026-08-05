/**
 * The dashboard's server-side apps gateway client.
 *
 * Every app-CRUD and git-connection door runs server-side: server actions
 * call these wrappers with the bearer from the cookie-bound Supabase server
 * session — there is no browser-held gateway client — closing the class of
 * bug where a call site forgets to thread the URL tenant and the gateway
 * silently falls back to the session's claim tenant.
 *
 * This talks to the gateway through a **typed `openapi-fetch` client** generated
 * from the gateway's OpenAPI spec (`api/generated/gateway-types.ts`). The request
 * path, params, and response shape are checked against the spec at compile time,
 * so a spec-compatible change that drops or renames a field breaks the build here
 * instead of silently at runtime.
 *
 * NOTE: this module reads the cookie-bound supabase session and must run
 * server-side. We deliberately don't import "server-only" so the vitest suite
 * (which imports actions.ts transitively) can `vi.mock(...)` this file without
 * tripping the server-only guard. The actual server-only semantics are enforced
 * by `createSupabaseServerClient` calling Next.js's `cookies()`.
 */

import createClient from "openapi-fetch";
import { createSupabaseServerClient } from "../../supabaseServerClient";
import { getRequestTenantId } from "../tenant/request-tenant";
import { GATEWAY_URL } from "../../config-global";
import type { paths } from "../api/generated/gateway-types";
import type {
  App,
  CreateAppBody,
  GitConnectAuthorization,
  GitRepository,
  LinkAppRepositoryBody,
  LinkAppRepositoryResult,
  StartGitConnectBody,
  UpdateAppBody,
} from "@repo/api-schemas";

const gateway = createClient<paths>({ baseUrl: GATEWAY_URL });

/**
 * Error thrown for any non-2xx gateway response, exposing the canonical error
 * envelope so callers can branch on `code` for UI behaviour (e.g.
 * `duplicate_app_name` → highlight the name field, `entitlement_required` →
 * render the upgrade prompt with the carried `entitlement` / `limit` / `current`
 * extras, `unsupported_git_provider` → a "reconnect with GitHub" message for a
 * legacy `gitlab` connection row).
 */
export class AppsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  /**
   * Whatever extras the gateway envelope carried beyond `code` + `message`.
   * For 402 entitlement responses this includes `entitlement` (string),
   * `limit` (number), and `current` (number). For 409
   * `unsupported_git_provider` this includes `provider` (string).
   */
  readonly extras: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    field?: string,
    extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppsApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.extras = extras;
  }
}

/**
 * Per-call auth headers: the bearer from the cookie-bound server session plus
 * the app-id the gateway routes on (omitted for the tenant-scoped list/create
 * routes — see `TENANT_SCOPED_V1_ROUTES` on the gateway). Resolved per request
 * (not via a client-level middleware) so it carries the caller's live token
 * AND leaves openapi-fetch's request body untouched — mutating the Request in
 * a middleware breaks its POST-body stream.
 */
async function authHeaders(appId: string | null): Promise<Record<string, string>> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new AppsApiError(401, "unauthorized", "No active session");
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (appId) headers["X-Outerlayer-App-Id"] = appId;
  // Carry the URL-derived request tenant so the gateway acts in the org the
  // user is viewing rather than the token's session-global claim. Absent
  // (no org in the path) ⇒ the gateway falls back to the claim, as before.
  const requestTenantId = await getRequestTenantId();
  if (requestTenantId) headers["X-Tenant-Id"] = requestTenantId;
  return headers;
}

/**
 * Map an `openapi-fetch` error (the parsed non-2xx body + the Response) to the
 * `AppsApiError` shape callers already handle — same envelope destructuring the
 * hand-rolled wrapper did.
 */
function toAppsApiError(error: unknown, response: Response): AppsApiError {
  const envelope = (error as { error?: Record<string, unknown> } | undefined)?.error;
  const extras: Record<string, unknown> = {};
  if (envelope) {
    for (const [key, value] of Object.entries(envelope)) {
      if (key !== "code" && key !== "message" && key !== "field") extras[key] = value;
    }
  }
  return new AppsApiError(
    response.status,
    typeof envelope?.code === "string" ? envelope.code : "request_failed",
    typeof envelope?.message === "string" ? envelope.message : `Gateway returned ${response.status}`,
    typeof envelope?.field === "string" ? envelope.field : undefined,
    extras,
  );
}

// ---------------------------------------------------------------------------
// Server-side gateway calls
// ---------------------------------------------------------------------------

/**
 * Create-app has no current app yet (first-app provisioning) — the header is
 * omitted and the gateway's tenant-scoped allowlist resolves scope from the
 * request tenant / JWT instead.
 */
export async function createAppFromServer(body: CreateAppBody): Promise<App> {
  const { data, error, response } = await gateway.POST("/v1/apps", {
    headers: await authHeaders(null),
    body,
  });
  if (error) throw toAppsApiError(error, response);
  return data.data;
}

export async function updateAppFromServer(appId: string, body: UpdateAppBody): Promise<App> {
  const { data, error, response } = await gateway.PATCH("/v1/apps/{appId}", {
    params: { path: { appId } },
    headers: await authHeaders(appId),
    body,
  });
  if (error) throw toAppsApiError(error, response);
  return data.data;
}

export async function deleteAppFromServer(appId: string): Promise<void> {
  const { error, response } = await gateway.DELETE("/v1/apps/{appId}", {
    params: { path: { appId } },
    headers: await authHeaders(appId),
  });
  if (error) throw toAppsApiError(error, response);
}

/**
 * Mint a per-provider OAuth authorization URL with a signed state token. On 503
 * `git_connect_not_configured` the gateway's provider OAuth is unusable — the
 * caller surfaces a "git connect temporarily unavailable" message.
 */
export async function startGitConnectFromServer(
  appId: string,
  body: StartGitConnectBody,
): Promise<GitConnectAuthorization> {
  const { data, error, response } = await gateway.POST("/v1/apps/{appId}/git/connect", {
    params: { path: { appId } },
    headers: await authHeaders(appId),
    body,
  });
  if (error) throw toAppsApiError(error, response);
  return data.data;
}

export async function listGitRepositoriesFromServer(appId: string): Promise<GitRepository[]> {
  const { data, error, response } = await gateway.GET("/v1/apps/{appId}/git/repositories", {
    params: { path: { appId } },
    headers: await authHeaders(appId),
  });
  if (error) throw toAppsApiError(error, response);
  return data.data;
}

export async function listGitBranchesFromServer(
  appId: string,
  repository: string,
): Promise<string[]> {
  const { data, error, response } = await gateway.GET("/v1/apps/{appId}/git/branches", {
    params: { path: { appId }, query: { repository } },
    headers: await authHeaders(appId),
  });
  if (error) throw toAppsApiError(error, response);
  return data.data;
}

export async function linkAppRepositoryFromServer(
  appId: string,
  body: LinkAppRepositoryBody,
): Promise<LinkAppRepositoryResult> {
  const { data, error, response } = await gateway.POST("/v1/apps/{appId}/git/link", {
    params: { path: { appId } },
    headers: await authHeaders(appId),
    body,
  });
  if (error) throw toAppsApiError(error, response);
  return data.data;
}
