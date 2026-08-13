import 'server-only';
import { AnalyticsError } from '@repo/observability-service';
import { ADMIN_API_KEY_PREFIX } from '@/lib/system/admin-api-key-service';

/**
 * A handful of org-scoped routes (custom roles, per-app member roles)
 * delegate straight to `authorizedAction`-wrapped EE actions that resolve
 * auth from the request session only — they have no bearer branch. Calling
 * one of those actions for a bearer caller throws an untyped
 * `Error("Not authenticated")`, which the wrapper's catch-all can only map to
 * a 500. Call this first so a bearer caller gets a clean, typed 401 instead —
 * the fix is in the response shape, not the auth decision: these endpoints
 * are session-only by design and stay that way.
 */
export function rejectAdminApiKeyBearer(request: Request): void {
  const authorizationHeader = request.headers.get('authorization');
  if (authorizationHeader?.startsWith(`Bearer ${ADMIN_API_KEY_PREFIX}`)) {
    throw new AnalyticsError(
      'Admin API keys are not supported on this endpoint; use a browser session',
      'unauthorized',
      401,
    );
  }
}
