/**
 * Browser-side **typed** client for the OuterLayer gateway (`/v1/*` routes).
 *
 * Why this exists separately from `client.ts`:
 *   `client.ts` is the typed `openapi-fetch` client for the dashboard's
 *   own Next.js API routes (`/api/...`), same-origin, typed from the
 *   dashboard's OpenAPI spec. The environments surface instead talks
 *   directly to gateway routes at a different origin (`GATEWAY_URL`),
 *   so it needs its own client bound to the gateway's spec.
 *
 * This is a typed `openapi-fetch` client generated from the gateway's
 * OpenAPI spec (`api/generated/gateway-types.ts`). Each wrapper's request
 * path, params, and response shape are checked against the spec at compile
 * time, so a spec change that drops or renames a field breaks the build
 * here instead of silently at runtime — there's no untyped transport where
 * the caller supplies both the path string and the response type `T` with
 * no compile-time link between them (a typo in either would go uncaught).
 *
 * The dashboard's `@/types/environment` wire types remain the callers' return
 * contract: they are a hand-maintained subset of the gateway rows (plus
 * client-only extras) and, for the deployment-history rows, carry
 * `@deprecated` aliases the spec doesn't model — see the cast
 * note on {@link getDeployment}.
 *
 * Auth: attaches the Supabase session bearer JWT, resolved per call (never
 * cached — Supabase rotates short-lived tokens and one `getSession()` is
 * dwarfed by the network round-trip). Resolved per request rather than via an
 * openapi-fetch middleware so it carries the caller's live token AND leaves the
 * request body untouched (mutating the Request in a middleware breaks its
 * POST-body stream).
 *
 * App scoping: every env route is app-scoped, so each wrapper takes `appId` and
 * sends it as `X-Outerlayer-App-Id`.
 *
 * Errors: non-2xx responses throw `GatewayError` carrying the structured
 * `{code, message, extras?}` envelope so callers can branch on `err.code`
 * (e.g. `create-env-dialog` focuses the name field on `env_name_conflict`).
 */

import createClient from 'openapi-fetch';

import { createSupabaseFontendClient } from '@/supabaseFrontendClient';
import { GATEWAY_URL } from '@/config-global';
import type { paths } from './generated/gateway-types';
import type {
  Environment,
} from '@/types/environment';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by the gateway wrappers on any non-2xx response or transport failure.
 * Preserves the gateway's structured error envelope so callers can branch on
 * `err.code` (e.g. show inline validation on `env_name_conflict`).
 */
export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extras: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.extras = extras;
  }
}

// ---------------------------------------------------------------------------
// Typed client + shared plumbing
// ---------------------------------------------------------------------------

const gateway = createClient<paths>({ baseUrl: GATEWAY_URL });

/**
 * Per-call auth headers: the bearer from the browser Supabase session plus the
 * app-id every env route scopes on. No active session → throw before issuing
 * the request so we don't waste a round-trip on a guaranteed 401.
 */
async function authHeaders(appId: string, tenantId?: string): Promise<Record<string, string>> {
  const supabase = createSupabaseFontendClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new GatewayError('unauthorized', 'No active session — please sign in again', 401);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.access_token}`,
    Accept: 'application/json',
    'X-Outerlayer-App-Id': appId,
  };
  // The URL-derived request tenant (from `useUrlTenantId`) scopes the call to
  // the org the user is viewing; the gateway validates membership fail-closed.
  // Omitted ⇒ the gateway falls back to the session claim, as before.
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return headers;
}

/**
 * Map an `openapi-fetch` error (the parsed non-2xx body + the Response) onto
 * the `GatewayError` contract callers already handle — the same canonical
 * envelope destructuring the hand-rolled transport did.
 */
function toGatewayError(error: unknown, response: Response): GatewayError {
  const envelope = (error as { error?: unknown } | undefined)?.error;
  if (
    envelope &&
    typeof envelope === 'object' &&
    'code' in envelope &&
    'message' in envelope
  ) {
    const { code, message, ...extras } = envelope as {
      code: string;
      message: string;
      [k: string]: unknown;
    };
    return new GatewayError(code, message, response.status, extras);
  }
  return new GatewayError(
    'malformed_response',
    `Gateway returned ${response.status} without canonical error envelope`,
    response.status,
  );
}

/**
 * Run a typed openapi-fetch call, mapping a thrown transport failure (DNS,
 * abort, CORS preflight reject) onto the same `network_error` GatewayError the
 * hand-rolled transport emitted. openapi-fetch re-throws fetch rejections
 * rather than returning `{error, response}`, so callers keep one error type.
 *
 * Resolve auth headers BEFORE calling this (outside the try) so an
 * `authHeaders` 401 propagates as-is instead of being remapped to
 * `network_error`. The generic `R` is the full openapi-fetch result union, so
 * the caller's `{data, error, response}` destructure stays fully typed.
 */
async function sendGateway<R extends { response: Response }>(
  send: () => Promise<R>,
): Promise<R> {
  try {
    return await send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GatewayError('network_error', `Gateway request failed: ${message}`, 0);
  }
}

// ---------------------------------------------------------------------------
// Environments — reads
// ---------------------------------------------------------------------------

/**
 * `GET /v1/environments` — the app's environments. Unwraps the canonical
 * `{data, pagination}` envelope to plain rows; pagination is intentionally
 * dropped (env counts are entitlement-bounded, single-digit by default).
 */
export async function listEnvironments(appId: string, tenantId?: string): Promise<Environment[]> {
  const headers = await authHeaders(appId, tenantId);
  const { data, error, response } = await sendGateway(() =>
    gateway.GET('/v1/environments', { headers }),
  );
  if (error) throw toGatewayError(error, response);
  return data.data;
}


