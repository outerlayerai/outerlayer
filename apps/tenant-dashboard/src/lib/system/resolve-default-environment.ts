import "server-only";

/**
 * The default-environment resolve for api-key minting, service-role.
 * `environment`'s SELECT policy requires `environment.read`
 * (`52-environment.sql:238-240`); an app-scoped custom role granting
 * `api_key.insert` need not grant it, so a user-scoped read would come back
 * empty and silently drop the env pin.
 */

import { getAdminDataClient } from "./admin-client";
import { resolveDefaultEnvironmentId } from "@/lib/environments/resolve-default-environment";

export async function resolveDefaultEnvironmentIdAsSystem(appId: string): Promise<string> {
  return resolveDefaultEnvironmentId(getAdminDataClient(), appId);
}
