import "server-only";

import type { PendingDeviceAuthRequest } from "./types";
import { deviceAuthService } from "./service";

/**
 * The RSC read behind the approval page: the pending request a user_code
 * still names, or null if it does not exist / already resolved / expired
 * (the page renders a single "this code is no longer valid" state for all
 * three, matching the poll endpoint's own enumeration-safe collapsing).
 */
export async function loadPendingDeviceAuthRequest(userCode: string): Promise<PendingDeviceAuthRequest | null> {
  const row = await deviceAuthService.findPendingByUserCode(userCode);
  if (!row) return null;
  return { requestId: row.id, userCode: row.user_code };
}
