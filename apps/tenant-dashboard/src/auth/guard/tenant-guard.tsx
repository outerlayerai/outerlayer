"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuthContext } from "../hooks";
import { useMemberships } from "../hooks/use-memberships";
import ForbiddenView from "../../sections/error/403-view";
import { SplashScreen } from '@/components/loading-screen';
import { paths } from "../../routes/paths";

type Props = {
  children: React.ReactNode;
};

/**
 * Validates the URL org against the caller's memberships — a page under
 * `/orgs/<org>/…` is already scoped to `<org>` by the middleware before this
 * component renders, so there is nothing to sync here.
 */
export default function TenantGuard({ children }: Props) {
  const { user, loading, authenticated } = useAuthContext();
  const { getMembershipByOrgName } = useMemberships();
  const { orgName } = useParams();
  const router = useRouter();

  const orgNameStr = Array.isArray(orgName) ? orgName[0] : orgName;
  const membership = getMembershipByOrgName(orgNameStr ?? "");
  const hasMembership = !!membership;

  // Redirect to /orgs when the user has no memberships rather than
  // showing a 403, which is reserved for access denied to a specific org.
  const userHasNoOrgs = authenticated && user && (user?.memberships ?? []).length === 0;
  useEffect(() => {
    if (userHasNoOrgs && !membership) {
      router.replace(paths.orgs.root);
    }
  }, [userHasNoOrgs, membership, router]);

  // Show loading while auth context is loading, or the user is logging out.
  // This prevents a 403 flash during logout.
  if (loading || !authenticated || !user) {
    return <SplashScreen />;
  }

  if (!hasMembership) {
    if (userHasNoOrgs) {
      // Redirect is handled by the effect above to avoid setState during render.
      return <SplashScreen />;
    }
    return <ForbiddenView />;
  }

  return children;
}
