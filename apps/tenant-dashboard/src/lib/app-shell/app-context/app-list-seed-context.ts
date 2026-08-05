"use client";

import { createContext } from "react";
import type { OrgAppRow } from "./app-list-context";

type SeedAppList = (apps: OrgAppRow[]) => void;

export const AppListSeedSetterContext = createContext<SeedAppList | null>(null);
