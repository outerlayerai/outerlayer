/** The approval page's read shape — enough to show the user what they are
 * about to authorize, never the device_code itself (the page never sees it;
 * only the polling CLI process does). */
export interface PendingDeviceAuthRequest {
  requestId: string;
  userCode: string;
}

export type ApproveDeviceAuthOutcome =
  | { ok: true }
  | { ok: false; errorCode: "permissions_exceed_caller" | "already_resolved"; message: string };

export type DenyDeviceAuthOutcome =
  | { ok: true }
  | { ok: false; errorCode: "already_resolved"; message: string };
