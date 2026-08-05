"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import { AppListContext, OrgAppRow } from "./app-list-context";
import { AppListSeedSetterContext } from "./app-list-seed-context";

/**
 * Mounted at `(authenticated)`, alongside `AppProvider` — the header's
 * `AppSelect` reads the org's app list from here. Seeded from the
 * `[appName]` React Server Component (RSC) layout via `<AppSeeder>`, the same seam `AppProvider` uses
 * for the app object; this provider opens no Supabase client of its own.
 */
export function AppListProvider({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const orgName = Array.isArray(params.orgName) ? params.orgName[0] : params.orgName;

  const [apps, setApps] = useState<OrgAppRow[]>([]);

  // Render-time reset: an org switch must not show the PREVIOUS org's app list
  // for one frame under the new org's route (mirrors AppProvider's app-switch
  // reset).
  const [scopedOrgName, setScopedOrgName] = useState(orgName);
  if (scopedOrgName !== orgName) {
    setScopedOrgName(orgName);
    setApps([]);
  }

  const seedAppList = useCallback((seeded: OrgAppRow[]) => {
    setApps(seeded);
  }, []);

  return (
    <AppListSeedSetterContext.Provider value={seedAppList}>
      <AppListContext.Provider value={apps}>{children}</AppListContext.Provider>
    </AppListSeedSetterContext.Provider>
  );
}
