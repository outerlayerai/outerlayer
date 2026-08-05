import { z } from "zod";

/** `github` is the only supported provider — the GitLab integration was
 *  removed, and the gateway rejects any other value with a 409. */
export const startGitConnectInput = z.object({
  appId: z.uuid(),
  provider: z.literal("github"),
});
