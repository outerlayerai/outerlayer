/**
 * License status projection (EE).
 *
 * Resolves the deployment's enterprise license into a CLIENT-SAFE shape: the
 * verified claims (org, plan, expiry) and a derived display state, but NEVER
 * the raw license key or signature. Both the server-rendered settings page and
 * the client-facing route (`/api/license/status`) build their view from this one
 * helper, so the surface and the grace banner can't disagree on state.
 *
 * Cloud deployments resolve to `{ visible: false }` — the whole license surface
 * is hidden there (`isSelfHostDeployment()` is false; there is no self-host
 * license on Cloud). Purely local: no network I/O (the verifier is offline).
 */
import "server-only";

import {
  isSelfHostDeployment,
  getSelfHostLicense,
  LICENSE_GRACE_DAYS,
  type EnvSource,
} from "@repo/ee-license";
import type { LicenseStatus } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `now` to `target`, never negative (0 once past). */
function daysUntil(targetMs: number, now: Date): number {
  return Math.max(0, Math.ceil((targetMs - now.getTime()) / MS_PER_DAY));
}

/**
 * Build the client-safe license status. `env`/`now` are injectable for tests;
 * production calls it argless (reads `process.env`, wall clock).
 */
export async function resolveLicenseStatus(
  env: EnvSource = process.env,
  now: Date = new Date(),
): Promise<LicenseStatus> {
  if (!isSelfHostDeployment(env)) return { visible: false };

  const license = await getSelfHostLicense(env, now);
  if (!license) return { visible: true, state: "unlicensed" };

  const { claims, inGrace } = license;
  const expMs = claims.exp * 1000;

  if (inGrace) {
    const graceEndsMs = expMs + LICENSE_GRACE_DAYS * MS_PER_DAY;
    return {
      visible: true,
      state: "grace",
      org: claims.org,
      plan: claims.plan,
      expiredAt: new Date(expMs).toISOString(),
      graceEndsAt: new Date(graceEndsMs).toISOString(),
      daysUntilGraceEnds: daysUntil(graceEndsMs, now),
    };
  }

  return {
    visible: true,
    state: "valid",
    org: claims.org,
    plan: claims.plan,
    expiresAt: new Date(expMs).toISOString(),
    daysUntilExpiry: daysUntil(expMs, now),
  };
}
