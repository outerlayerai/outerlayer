import { z } from "zod";

/** `requestId` is the device_auth_request row id the read-side already
 * resolved (never client-supplied guesswork) — the atomic UPDATE inside
 * `approveDeviceAuthRequest` re-checks it is still pending and unexpired at
 * write time regardless. */
export const approveDeviceAuthInput = z.object({
  requestId: z.string().uuid(),
  appId: z.string(),
});

export const denyDeviceAuthInput = z.object({
  requestId: z.string().uuid(),
});
