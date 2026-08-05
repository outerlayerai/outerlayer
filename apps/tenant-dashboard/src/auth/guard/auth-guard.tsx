"use client";

import { useState, useEffect, useCallback } from "react";

import { useAuthContext } from "../hooks";
import { paths } from "../../routes/paths";
import { SplashScreen } from '@/components/loading-screen';
import { useRouter } from "../../routes/hooks";
import { usePostHogPageview } from "../../hooks/use-posthog-pageview";

// ----------------------------------------------------------------------

const loginPath = paths.auth.login;

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

export default function AuthGuard({ children }: Props) {
  const { loading } = useAuthContext();

  return <>{loading ? <SplashScreen /> : <Container>{children}</Container>}</>;
}

// ----------------------------------------------------------------------

function Container({ children }: Props) {
  const router = useRouter();

  const { authenticated } = useAuthContext();

  // PostHog: Capture pageview on navigation for all authenticated routes
  usePostHogPageview();

  const [checked, setChecked] = useState(false);

  const check = useCallback(() => {
    if (!authenticated) {
      // Preserve the full URL (path + query) so the login flow can deposit
      // the user back where they started. The query string matters: invite
      // links land on `/auth/accept-invite?id=<membershipId>` and the page
      // is unusable without the `id`. The param name must be `return_to` —
      // that's what `/auth/login` reads and threads through both the
      // password flow and the OAuth `redirectTo` chain.
      const searchParams = new URLSearchParams({
        return_to: window.location.pathname + window.location.search,
      }).toString();

      const href = `${loginPath}?${searchParams}`;

      router.replace(href);
    } else {
      setChecked(true);
    }
  }, [authenticated, router]);

  useEffect(() => {
    check();
  }, [check]);

  if (!checked && !authenticated) {
    return null;
  }

  return <>{children}</>;
}
