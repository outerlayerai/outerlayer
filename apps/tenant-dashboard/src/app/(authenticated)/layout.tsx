"use client";

import { AuthGuard, TermsGuard } from "../../auth/guard";
import { ShellNavProvider } from "../../layouts/shell-nav-context";
import { AppHeader } from "../../layouts/app-header";
import { AppProvider } from "@/lib/app-shell/app-context";
import { AppListProvider } from "@/lib/app-shell/app-context";
import { EnvProvider } from "../../context/env-context";

type Props = {
  children: React.ReactNode;
};

export default function Layout({ children }: Props) {
  return (
    <AuthGuard>
      <TermsGuard>
        {/*
          The header is mounted HERE, at the common ancestor of both shells, so
          it persists across every authenticated navigation instead of
          remounting per route (the org→app flash). Each shell (AppLayout /
          DashboardLayout) now renders only its content frame and, for the app
          shell, its rail. ShellNavProvider carries the mobile drawer state the
          header and rail share.

          AppProvider + AppListProvider + EnvProvider sit ABOVE the header for
          the same reason the header sits above the shells: the breadcrumb
          spine's App/Env segments read them. `<AppBreadcrumb.EnvSelect>`
          self-hides when it can't reach an `<EnvProvider>`, so mounting the
          persistent header outside the providers would make the env selector
          vanish from every app page. All three providers no-op gracefully
          outside an app route (`appName` param absent): AppProvider settles to
          `app: null`, AppListProvider to an empty list, EnvProvider to the
          default-env selection — none of them query anything themselves, and
          the App/Env segments collapse anyway.
        */}
        <ShellNavProvider>
          <AppProvider>
            <AppListProvider>
              <EnvProvider>
                <AppHeader />
                {children}
              </EnvProvider>
            </AppListProvider>
          </AppProvider>
        </ShellNavProvider>
      </TermsGuard>
    </AuthGuard>
  );
}
