import "server-only";

import type { ContextActor } from "./save-service";

/**
 * Resolves the acting user's display identity for the `Saved-by:` commit
 * trailer (see `APP_CONNECTION_COMMIT_AUTHOR` in `save-service.ts`).
 * `display_name` is the canonical profile field (see `hooks/use-profile.ts`,
 * `app/auth/confirm/route.ts`); falls back to email when unset.
 */
export function resolveActor(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): ContextActor {
  const email = user.email ?? "unknown@outerlayer.ai";
  const displayName = user.user_metadata?.display_name;
  const name = typeof displayName === "string" && displayName.length > 0 ? displayName : email;
  return { name, email };
}
