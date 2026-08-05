import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { appsService } from "./service";
import type { AppWithGitConnection } from "./types";

/**
 * The React Server Component (RSC) read behind the org apps-list page: every app in the request
 * tenant plus its git-connection + environment status, resolved under the
 * caller's RLS-scoped client. The page calls this server-side and seeds the
 * list — the list never fetches on mount.
 */
export async function loadAppsList(): Promise<AppWithGitConnection[]> {
  const ctx = await loadRequestServiceContext();
  return appsService.listAppsWithGitStatus(ctx);
}
