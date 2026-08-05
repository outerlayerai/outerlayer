"use client";

import { useEffect, useRef } from "react";

import { useAuthContext } from "../hooks";
import { SplashScreen } from '@/components/loading-screen';
import { paths } from "../../routes/paths";
import { useRouter } from "../../routes/hooks";
import { sanitizeReturnTo } from "../../lib/auth/sanitize-return-to";

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

/**
 * GuestGuard protects auth pages (login, register, etc.)
 * Redirects authenticated users:
 * - 1 org: directly to that org (skip picker)
 * - 0 or 2+ orgs: to /orgs (picker or create)
 */
export default function GuestGuard({ children }: Props) {
  const { loading } = useAuthContext();

  return <>{loading ? <SplashScreen /> : <Container>{children}</Container>}</>;
}

// ----------------------------------------------------------------------

function Container({ children }: Props) {
  const router = useRouter();
  const { authenticated, user } = useAuthContext();
  const hasRedirected = useRef(false);

  useEffect(() => {
    // Re-arm the one-shot redirect on every unauthenticated phase. Without
    // this, a stale `authenticated: true` (e.g. a session that died server-side
    // while this tree stayed mounted) burns the ref before the real login, and
    // the subsequent authenticated transition would never redirect — stranding
    // the user on the login page.
    if (!authenticated) {
      hasRedirected.current = false;
      return;
    }
    if (hasRedirected.current) return;
    hasRedirected.current = true;

    // A `return_to` param means the user was bounced here from a protected
    // page (e.g. an invite link to `/auth/accept-invite?id=…`). Once the
    // session exists, resume that flow instead of the org default.
    const returnTo = sanitizeReturnTo(
      new URLSearchParams(window.location.search).get("return_to"),
    );
    if (returnTo) {
      router.replace(returnTo);
      return;
    }

    const memberships = user?.memberships ?? [];

    // Single org - go directly to it (skip picker)
    if (memberships.length === 1) {
      const orgName = memberships[0]?.tenant?.organization_name;
      if (orgName) {
        router.replace(paths.orgs.org.apps.root(orgName));
        return;
      }
    }

    // 0 or 2+ orgs - go to /orgs (will show picker or create page)
    router.replace(paths.orgs.root);
  }, [authenticated, user, router]);

  return <>{children}</>;
}
