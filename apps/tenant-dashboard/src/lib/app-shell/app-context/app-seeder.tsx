"use client";

import { useContext, useEffect } from "react";
import { AppSeedSetterContext } from "./app-seed-context";
import type { AppWithGitConnection } from "./app-context";
import { AppListSeedSetterContext } from "./app-list-seed-context";
import type { OrgAppRow } from "./app-list-context";

type Props = {
  app: AppWithGitConnection | null;
  /** The org's app list (for the breadcrumb `AppSelect`) — omitted where the caller has no list to seed. */
  apps?: OrgAppRow[];
  children: React.ReactNode;
};

/**
 * Pushes the `[appName]` React Server Component (RSC)'s server-resolved app row (and org app list) up
 * into the `AppProvider`/`AppListProvider` mounted above it at
 * `(authenticated)` — the header's `AppSelect`/`EnvSelect` and `EnvProvider`
 * read from those high providers, so this data can't live where it
 * resolves. Renders no DOM of its own; the seed happens post-mount (a
 * `useEffect`), so the first render under a new `appName` still shows
 * `app: null` for one frame.
 */
export function AppSeeder({ app, apps, children }: Props) {
  const seedApp = useContext(AppSeedSetterContext);
  const seedAppList = useContext(AppListSeedSetterContext);

  useEffect(() => {
    seedApp?.(app);
  }, [seedApp, app]);

  useEffect(() => {
    if (apps !== undefined) seedAppList?.(apps);
  }, [seedAppList, apps]);

  return <>{children}</>;
}
