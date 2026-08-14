import { Suspense } from "react";

import { OAuthGrantsList, OAuthGrantsLoading, OAuthGrantsError } from "@/features/oauth-grants";
import { loadOAuthGrants } from "@/features/oauth-grants/read";

export const metadata = {
  title: "Connected Apps",
};

/**
 * Connector grants are scoped to the signed-in user, not this app/env — the
 * page ignores its route params and always shows the caller's own grants,
 * same list wherever it's opened from.
 */
async function OAuthGrantsContent() {
  const result = await loadOAuthGrants();

  if ("unresolved" in result) {
    return <OAuthGrantsError />;
  }

  return <OAuthGrantsList grants={result.grants} />;
}

export default function OAuthGrantsPage() {
  return (
    <Suspense fallback={<OAuthGrantsLoading />}>
      <OAuthGrantsContent />
    </Suspense>
  );
}
