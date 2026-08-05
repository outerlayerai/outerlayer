"use client";

import { useEffect } from "react";
import { usePathname, useParams } from "next/navigation";
import posthog from "posthog-js";
import { useAuthContext } from "../auth/hooks";

/**
 * Hook to capture PostHog pageview events with normalized paths.
 * Replaces dynamic route segments with parameter names (e.g., /orgs/acme -> /orgs/[orgName])
 *
 * Properties captured:
 * - page_path: Normalized path with [paramName] placeholders
 * - tenant_id: Current tenant ID (names available via PostHog Groups)
 * - param_*: Route params (e.g., param_orgName, param_appName)
 *
 * Excludes: Platform admin routes (internal tooling, not product analytics)
 */
export function usePostHogPageview() {
  const { user } = useAuthContext();
  const pathname = usePathname();
  const params = useParams();

  useEffect(() => {
    // Skip tracking for platform admin routes
    if (pathname.startsWith("/platform-admin")) {
      return;
    }

    // Normalize path by replacing dynamic values with param names
    let normalizedPath = pathname;
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        normalizedPath = normalizedPath.replace(String(value), `[${key}]`);
      }
    }

    // Build param properties (e.g., param_orgName, param_appName)
    const paramProperties: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        paramProperties[`param_${key}`] = String(value);
      }
    }

    posthog.capture("$pageview", {
      page_path: normalizedPath,
      tenant_id: user?.activeTenant?.tenant_id,
      ...paramProperties,
    });
  }, [pathname, params, user?.activeTenant?.tenant_id]);
}
