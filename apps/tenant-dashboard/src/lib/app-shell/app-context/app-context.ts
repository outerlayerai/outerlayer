"use client";

import { createContext } from "react";
import type { AppWithGitConnection } from "@/utils/get-app-by-name";

export type { AppWithGitConnection };

type Type = {
  app: AppWithGitConnection | null;
  loading: boolean;
  hasCreatedTrace: boolean;
  /**
   * Imperatively mark the first trace as seen — flips `hasCreatedTrace` true so
   * the onboarding surfaces give way to real content without a full page
   * reload. Wired by the "Check now" button on the getting-started panel.
   */
  markTraceSeen: () => void;
};

export const AppContext = createContext<Type>({
  app: null,
  loading: true,
  hasCreatedTrace: false,
  markTraceSeen: () => {},
});
