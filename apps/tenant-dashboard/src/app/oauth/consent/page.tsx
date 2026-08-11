import { redirect } from "next/navigation";
import { Alert, Card, Stack, Typography } from "@mui/material";

import { paths } from "@/routes/paths";
import { sanitizeReturnTo } from "@/lib/auth/sanitize-return-to";
import { loadOAuthConsent } from "@/features/oauth-consent/read";
import { OAuthConsentView } from "@/features/oauth-consent";

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
    return <ErrorCard titleKey="missingAuthorization" />;
  }

  const result = await loadOAuthConsent(authorizationId).catch(() => null);

  if (result === null) {
    return <ErrorCard titleKey="error" />;
  }

  if (result.kind === "unauthenticated") {
    const returnTo = sanitizeReturnTo(`/oauth/consent?authorization_id=${authorizationId}`);
    redirect(`${paths.auth.login}${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`);
  }

  if (result.authorization.status === "auto-approved") {
    redirect(result.authorization.redirectUrl);
  }

  return (
    <OAuthConsentView
      authorizationId={result.authorization.authorizationId}
      clientName={result.authorization.clientName}
      scopes={result.authorization.scopes}
      resource={result.authorization.resource}
    />
  );
}

function ErrorCard({ titleKey }: { titleKey: "missingAuthorization" | "error" }) {
  const copy =
    titleKey === "missingAuthorization"
      ? {
          title: "Missing authorization",
          description:
            "This link is missing the information needed to complete the connection. Try connecting again from the client that sent you here.",
        }
      : {
          title: "Something went wrong",
          description:
            "We couldn't complete this connection. Try again from the client that sent you here.",
        };
  return (
    <Card sx={{ p: 4, maxWidth: 480, mx: "auto", mt: 8 }}>
      <Stack spacing={2}>
        <Typography variant="h5">{copy.title}</Typography>
        <Alert severity="error">{copy.description}</Alert>
      </Stack>
    </Card>
  );
}
