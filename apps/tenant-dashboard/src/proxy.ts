import { type NextRequest } from "next/server";
import { updateSession } from "./utils/supabase/middleware";

/**
 * Next.js middleware entry (proxy). Every matched request refreshes the Supabase
 * session through ONE refresher — `updateSession`.
 *
 * The matcher covers ALL of `/api/**` so the inbound `x-tenant-id` is stripped
 * on every api path — a client must never hand a downstream handler a forged
 * tenant header. The image-extension exclusion is scoped to NON-api paths
 * (`(?!api/)`): an api route whose last segment happens to end in an image
 * extension (e.g. a `runId` of `foo.png`) must still be matched and stripped,
 * not skipped as a static asset. Self-authenticating or tenant-agnostic prefixes
 * (webhooks, cron, cli, internal, the health/analytics probes) are strip-only in
 * `updateSession` — they run no `getUser()`. That keeps session-token rotation in
 * exactly one place: two server-side refreshers racing on the shared refresh
 * token could leave the browser holding a superseded token, which past Supabase's
 * `refresh_token_reuse_interval` the reuse detector revokes — a random mid-session
 * logout, most often while a heavily-polled dashboard route is refreshing.
 */
export default async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|(?!api/).*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
