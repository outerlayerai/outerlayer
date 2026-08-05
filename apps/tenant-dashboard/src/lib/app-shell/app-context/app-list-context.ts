"use client";

import { createContext, useContext } from "react";
import type { OrgAppRow } from "@/utils/list-org-apps";

export type { OrgAppRow };

/** Defaults to empty — the "nothing yet" shape consumers render before the seed lands. */
export const AppListContext = createContext<OrgAppRow[]>([]);

/** The org's apps, seeded from the `[appName]` React Server Component (RSC) layout via `<AppSeeder>`. */
export function useAppList(): OrgAppRow[] {
  return useContext(AppListContext);
}
