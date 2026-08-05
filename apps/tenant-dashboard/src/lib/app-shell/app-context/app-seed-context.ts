"use client";

import { createContext } from "react";
import type { AppWithGitConnection } from "./app-context";

/**
 * The setter the `[appName]` React Server Component (RSC)'s client seeder (`<AppSeeder>`) uses to push
 * the server-resolved app row up into the `AppProvider` mounted above it at
 * `(authenticated)`. `AppProvider` itself never opens a Supabase client — this
 * is the only channel data reaches it through.
 */
type SeedApp = (app: AppWithGitConnection | null) => void;

export const AppSeedSetterContext = createContext<SeedApp | null>(null);
