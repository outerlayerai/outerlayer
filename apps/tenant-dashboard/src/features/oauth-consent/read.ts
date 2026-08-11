import "server-only";

import { env } from "@/env";
import { loadPreTenantActorSession } from "@/lib/adapters";

import { oauthConsentService } from "./service";
import type { BoundAuthorization } from "./types";

type LoadOAuthConsentResult =
  | { kind: "unauthenticated" }
  | { kind: "bound"; authorization: BoundAuthorization };

/**
 * The read behind `/oauth/consent`. Resolves the signed-in user's own
 * access token and binds the authorization to them — the GET call spec §5.4
 * documents as required before any consent decision can be posted, and
 * which itself auto-approves a repeat connect.
 */
export async function loadOAuthConsent(authorizationId: string): Promise<LoadOAuthConsentResult> {
  const session = await loadPreTenantActorSession();
  if (!session) {
    return { kind: "unauthenticated" };
  }

  const authorization = await oauthConsentService.bindAuthorization(
    env.NEXT_PUBLIC_SUPABASE_URL,
    session.accessToken,
    authorizationId,
  );
  return { kind: "bound", authorization };
}
