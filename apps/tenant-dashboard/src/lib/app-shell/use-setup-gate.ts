"use client";

import { useAppContext } from "@/lib/adapters/use-app-context";

/**
 * Onboarding v2: trace-family pages (Dashboard, Traces, Sessions, Requests)
 * hide their real content before the app's first trace — no redirect, no
 * per-page placeholder drift; they render nothing while `showSetup` is true
 * and rely on the global `RepoGateBanner`/`GettingStartedChecklist` (mounted
 * in `app-layout-shell.tsx`) for onboarding guidance.
 *
 * `showSetup` flips ONLY once the AppProvider trace check has resolved
 * (`!loading && app`): showing it while the check is in flight would flash
 * it at every returning user. Callers render their own loading state while
 * `pending` is true, hide their content while `showSetup` is true, and the
 * real page otherwise. The AppProvider keeps polling has-traces pre-trace,
 * so callers swap to live content in place the moment the first trace lands.
 */
export function useSetupGate(): { pending: boolean; showSetup: boolean } {
  const { app, loading, hasCreatedTrace } = useAppContext();
  return {
    pending: loading,
    showSetup: !loading && Boolean(app) && !hasCreatedTrace,
  };
}
