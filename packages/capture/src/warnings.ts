// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { ParseWarning } from "@outerlayer/session-schema";

/** Stable warning codes. */
export const WARNING_CODES = {
  unknownLineType: "unknown_line_type",
  malformedLine: "malformed_line",
  truncatedFinalLine: "truncated_final_line",
  versionNewer: "version_newer_than_supported",
  ambiguousTimezone: "ambiguous_timezone",
  unknownModelCost: "unknown_model_cost",
} as const;

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];

/** Accumulates warnings by code with a bounded sample detail. */
export class WarningCollector {
  private readonly counts = new Map<string, number>();
  private readonly details = new Map<string, string>();

  add(code: string, detail?: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    if (detail && !this.details.has(code)) {
      this.details.set(code, detail.slice(0, 200));
    }
  }

  has(code: string): boolean {
    return this.counts.has(code);
  }

  toArray(): ParseWarning[] {
    return [...this.counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => {
        const detail = this.details.get(code);
        return detail ? { code, count, detail } : { code, count };
      });
  }

  /** Histogram for `--verbose` reports. */
  histogram(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
