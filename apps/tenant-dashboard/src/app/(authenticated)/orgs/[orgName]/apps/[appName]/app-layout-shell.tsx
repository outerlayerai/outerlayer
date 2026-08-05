"use client";

import { AppGuard } from "../../../../../../auth/guard";
import DashboardLayout from "../../../../../../layouts/dashboard";
import { GettingStartedChecklist } from "@/features/onboarding/components/getting-started-checklist";
import { RepoGateBanner } from "@/features/onboarding/components/repo-gate-banner";

type Props = {
  children: React.ReactNode;
};

/**
 * Client half of the `[appName]` layout — the guard/chrome tree.
 * The server half (`layout.tsx`) resolves the app's permission snapshot and
 * mounts `AppPermissionsProvider` above this shell.
 *
 * AppProvider + EnvProvider are NOT mounted here: they live in the
 * `(authenticated)` layout, above the persistent header, so the breadcrumb
 * spine's App/Env segments (`<AppBreadcrumb.EnvSelect>` — the single env
 * selector for the app) resolve the same context as this subtree.
 * They still wrap this entire chrome (rail + content frame), so the rail's
 * env-scoped nav links resolve even while the app record is loading.
 */
export function AppLayoutShell({ children }: Props) {
  // The dashboard chrome (rail + content frame) mounts IMMEDIATELY on an app
  // route, before the app record resolves, so the loading state reads as the
  // app frame: the rail — which owns the top-left logo — fills the strip the
  // persistent header reserves on app-detail, and the loader centers inside
  // the offset content pane.
  //
  // AppGuard therefore gates only the CONTENT: while loading it renders its
  // LoadingScreen INSIDE `LayoutMain`, not in place of the whole shell.
  // Keeping the rail mounted across the load also removes its mount-flash on
  // every app open.
  return (
    <DashboardLayout>
      <AppGuard>
        {/*
          Soft repo gate — traces arrived but no repository is linked;
          persistent by design. Then the unified getting-started checklist —
          persistent + dismissible, auto-hides once every step is complete.
          Both need the resolved app, so they live inside the guard.
        */}
        <RepoGateBanner />
        <GettingStartedChecklist />
        {children}
      </AppGuard>
    </DashboardLayout>
  );
}
