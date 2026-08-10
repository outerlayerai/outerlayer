import "server-only";

import { App } from "octokit";
import { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } from "./config-global.server";

// Explicit return type: the inferred one names @octokit/webhooks through a
// nested node_modules path, which is not portable across install layouts
// (TS2742 in consumers that typecheck against this file's declarations).
export const getGithubApp = (): App => {
  // The private key is optional config: a deployment without a GitHub App still
  // serves sessions and traces. Callers reach here only on the repo-linking and
  // PR-outcome paths, so fail with the reason rather than constructing an App
  // that produces an opaque auth error on its first request.
  if (!GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      "GitHub App is not configured on this deployment: GITHUB_APP_PRIVATE_KEY is unset.",
    );
  }
  return new App({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY,
  });
}
