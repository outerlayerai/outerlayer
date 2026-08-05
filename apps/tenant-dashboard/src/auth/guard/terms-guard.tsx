"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuthContext } from "../hooks";
import { SplashScreen } from '@/components/loading-screen';
import { checkTermsAgreementAction } from "@/features/auth/action-adapters";

// ----------------------------------------------------------------------

// Paths that are allowed even without terms agreement
const TERMS_EXEMPT_PATHS = [
  "/auth/terms-agreement",
  "/auth/login",
  "/auth/register",
  "/auth/logout",
  "/auth/forgot-password",
  "/auth/new-password",
  "/auth/verify",
  "/auth/callback",
  "/auth/auth-code-error",
  "/auth/accept-invite", // Terms handled inline on the page via checkTermsForInvitation()
];

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

/**
 * TermsGuard - Wraps protected routes and ensures users have agreed to terms.
 *
 * Non-Blocking Policy (002-terms-update-policy):
 * - Users with ANY existing agreement are NEVER blocked on terms version updates
 * - Only users with NO agreement at all are blocked (first-time users)
 * - This implements the "continued use = acceptance" legal policy
 *
 * Blocking behavior:
 * - needsCurrentVersion=true → User has NO agreement → Redirect to /auth/terms-agreement
 * - needsCurrentVersion=false → User has some agreement → Allow access (regardless of version)
 *
 * Compliance is maintained by the audit trail in terms_agreement table:
 * - Records explicit acceptance at registration with timestamp, IP, user agent
 * - Tracks which version each user originally agreed to
 * - Immutable records for legal defensibility
 *
 * Note: Uses refs for hasChecked/isRedirecting to avoid infinite loops.
 * State changes in useCallback deps cause callback recreation, triggering
 * useEffect re-runs. Refs avoid this by not causing re-renders.
 */
export default function TermsGuard({ children }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { authenticated, loading } = useAuthContext();

  const [termsChecked, setTermsChecked] = useState(false);
  const [termsValid, setTermsValid] = useState(false);

  // Use refs to track check/redirect state without causing re-renders
  // This prevents infinite loops from useCallback dependency changes
  const hasCheckedRef = useRef(false);
  const isRedirectingRef = useRef(false);

  const isExemptPath = TERMS_EXEMPT_PATHS.some((path) =>
    pathname.startsWith(path)
  );

  const checkTerms = useCallback(async () => {
    // Skip check if not authenticated or on exempt path
    if (!authenticated || isExemptPath) {
      setTermsChecked(true);
      setTermsValid(true);
      return;
    }

    // Avoid duplicate checks or if already redirecting (using refs to prevent loops)
    if (hasCheckedRef.current || isRedirectingRef.current) {
      return;
    }
    hasCheckedRef.current = true;

    try {
      const result = await checkTermsAgreementAction();

      if (result.error) {
        // On error, allow access but log warning
        console.warn("[TermsGuard] Failed to check terms:", result.error);
        setTermsValid(true);
        setTermsChecked(true);
        return;
      }

      if (result.data?.needsCurrentVersion) {
        // User needs to agree to terms - redirect to blocking screen
        isRedirectingRef.current = true;
        const termsUrl = new URL("/auth/terms-agreement", window.location.origin);
        termsUrl.searchParams.set("blocking", "true");
        termsUrl.searchParams.set("return_to", pathname);
        router.replace(termsUrl.toString());
        return;
      }

      // User has agreed to terms (any version - non-blocking policy)
      setTermsValid(true);
      setTermsChecked(true);
    } catch (error) {
      console.error("[TermsGuard] Error checking terms:", error);
      // On error, allow access
      setTermsValid(true);
      setTermsChecked(true);
    }
  }, [authenticated, isExemptPath, pathname, router]);

  useEffect(() => {
    // Wait for auth to complete loading
    if (!loading) {
      checkTerms();
    }
  }, [loading, checkTerms]);

  // Show loading while auth is loading or terms are being checked
  if (loading || (!termsChecked && authenticated && !isExemptPath)) {
    return <SplashScreen />;
  }

  // If terms aren't valid, we're redirecting (don't render children)
  if (!termsValid && !isExemptPath) {
    return <SplashScreen />;
  }

  return <>{children}</>;
}
