"use server";

import { authorizedAction } from "@/lib/action-kit";
import { AppsApiError, startGitConnectFromServer } from "@/lib/apps/server-client";

import { startGitConnectInput } from "./schemas";

/**
 * Mint a signed OAuth authorization URL for an app's git connection. Shared
 * by the apps-list settings menu and onboarding's repo-connect gate — both
 * features call this rather than each holding their own gateway client, and
 * neither imports the other's internals (features stay leaves).
 *
 * `git_connect_not_configured` (503, provider OAuth unusable) is the one
 * code callers specifically branch on; every other gateway error passes
 * through with its message.
 */
export const startGitConnectAction = authorizedAction({
  input: startGitConnectInput,
  permission: "app.update",
  appId: (input) => input.appId,
  handler: async (_ctx, input) => {
    try {
      const authorization = await startGitConnectFromServer(input.appId, {
        provider: input.provider,
      });
      return { ok: true as const, authorizationUrl: authorization.authorization_url };
    } catch (err) {
      if (err instanceof AppsApiError) {
        return { ok: false as const, errorCode: err.code, message: err.message };
      }
      throw err;
    }
  },
});
