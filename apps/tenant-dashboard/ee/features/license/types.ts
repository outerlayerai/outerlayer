/**
 * License status shape shared by the server-only resolver (`service.ts`) and
 * client components (`components/license-grace-banner.tsx`) — kept in its own
 * module with no imports so a `"use client"` file can import the type without
 * pulling in `service.ts`'s `"server-only"` sibling.
 */
export type LicenseStatus =
  // Cloud, or any deployment that isn't self-hosted → surface hidden entirely.
  | { visible: false }
  // Self-host, no valid license (unset / bad signature / expired past grace).
  | { visible: true; state: "unlicensed" }
  // Self-host, license valid and before expiry.
  | {
      visible: true;
      state: "valid";
      org: string;
      plan: string;
      /** ISO 8601 expiry instant. */
      expiresAt: string;
      /** Whole days until expiry (0 on the expiry day). */
      daysUntilExpiry: number;
    }
  // Self-host, past expiry but inside the grace window — EE still works.
  | {
      visible: true;
      state: "grace";
      org: string;
      plan: string;
      /** ISO 8601 instant the license expired. */
      expiredAt: string;
      /** ISO 8601 instant EE features deactivate. */
      graceEndsAt: string;
      /** Whole days until grace ends (0 on the last grace day). */
      daysUntilGraceEnds: number;
    };
