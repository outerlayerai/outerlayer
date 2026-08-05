import "server-only";

import { App } from "octokit";
import { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } from "./config-global.server";

// Explicit return type: the inferred one names @octokit/webhooks through a
// nested node_modules path, which is not portable across install layouts
// (TS2742 in consumers that typecheck against this file's declarations).
export const getGithubApp = (): App => {
  return new App({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY,
  });
}
