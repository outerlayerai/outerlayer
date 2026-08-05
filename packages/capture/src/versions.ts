// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Claude Code writer versions this parser was validated against.
 * Surveyed 2026-07-06 across a ~9.1k-session corpus (2.1.141 → 2.1.198).
 * A transcript reporting a version above the max parses best-effort with a
 * prominent `version_newer_than_supported` warning — never a throw.
 */
export const SUPPORTED_VERSIONS = {
  min: "2.1.0",
  // inclusive upper bound of what we've validated; bump as new versions land
  max: "2.1.255",
} as const;

/** Compare dotted numeric versions. Missing/garbage sorts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function parseVersion(v: string): number[] {
  return (v || "").split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/** True when `version` is strictly newer than the validated max. */
export function isNewerThanSupported(version: string): boolean {
  return compareVersions(version, SUPPORTED_VERSIONS.max) > 0;
}
