import { redirect } from "next/navigation";

import { paths } from "@/routes/paths";
import { sanitizeReturnTo } from "@/lib/auth/sanitize-return-to";
import { loadOAuthConsent } from "@/features/oauth-consent/read";
import { OAuthConsentView, OAuthConsentErrorCard } from "@/features/oauth-consent";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect to OuterLayer",
};

/**
 * `authorization_url_path` in `supabase/config.toml`'s `[auth.oauth_server]`
 * section — Supabase's OAuth server redirects here mid-authorize with an
 * `authorization_id` query param identifying the pending authorization.
 */
export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: authorizationId } = await searchParams;

  if (!authorizationId) {
    return <OAuthConsentErrorCard variant="missingAuthorization" />;
  }

  const result = await loadOAuthConsent(authorizationId).catch(() => null);

  if (result === null) {
    return <OAuthConsentErrorCard variant="error" />;
  }

  if (result.kind === "unauthenticated") {
    // Encoded so a crafted id can't smuggle extra query params (or truncate
    // itself at a `#`) through the login round-trip.
    const returnTo = sanitizeReturnTo(`/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`);
    redirect(`${paths.auth.login}${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`);
  }

  if (result.authorization.status === "auto-approved") {
    redirect(result.authorization.redirectUrl);
  }

  return (
    <OAuthConsentView
      authorizationId={result.authorization.authorizationId}
      clientName={result.authorization.clientName}
      resource={result.authorization.resource}
      redirectHost={result.authorization.redirectHost}
    />
  );
}
