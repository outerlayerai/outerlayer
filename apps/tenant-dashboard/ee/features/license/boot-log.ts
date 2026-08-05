/**
 * Boot-time license logging (EE).
 *
 * Extracted from the Next.js `instrumentation.ts` hook so the log-shaping logic
 * is a pure, tested function rather than untestable surface inside the runtime
 * hook. `instrumentation.ts` just awaits `logLicenseStateAtBoot()`.
 */
import { resolveLicenseStatus } from "./service";
import type { LicenseStatus } from "./types";

/**
 * The structured boot log line for a resolved status, or `null` when there's
 * nothing to log (Cloud / surface hidden). Pure — the caller owns the sink.
 */
export function licenseBootLogLine(status: LicenseStatus): string | null {
  if (!status.visible) return null;

  const base = { event: "ee_license_state", state: status.state };
  if (status.state === "valid") {
    return JSON.stringify({
      ...base,
      org: status.org,
      expiresAt: status.expiresAt,
      daysUntilExpiry: status.daysUntilExpiry,
    });
  }
  if (status.state === "grace") {
    return JSON.stringify({
      ...base,
      org: status.org,
      graceEndsAt: status.graceEndsAt,
      daysUntilGraceEnds: status.daysUntilGraceEnds,
    });
  }
  // unlicensed — state only; no org/expiry to report.
  return JSON.stringify(base);
}

/**
 * Resolve the license and emit one structured line to `log` (default
 * `console.log`) if there's anything to report. Never throws — license logging
 * must never break boot. `log`/`env`/`now` are injectable for tests.
 */
export async function logLicenseStateAtBoot(
  log: (line: string) => void = console.log,
  env?: Record<string, string | undefined>,
  now?: Date,
): Promise<void> {
  try {
    const line = licenseBootLogLine(await resolveLicenseStatus(env, now));
    if (line) log(line);
  } catch {
    // Swallow — a logging failure must not affect boot.
  }
}
