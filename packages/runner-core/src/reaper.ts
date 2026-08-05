// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { SandboxInfo, SandboxProvider } from "./types.js";
import { NOOP_SINK, safeSink, type EventSink } from "./events.js";

export interface ReapOptions {
  /** Destroy sandboxes older than this. */
  ttlMs: number;
  eventSink?: EventSink;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ReapReport {
  inspected: number;
  destroyed: SandboxInfo[];
  failures: { sandbox: SandboxInfo; error: string }[];
}

/**
 * The orphan GC: destroys every outerlayer-labeled sandbox older
 * than TTL, regardless of who created it or how its process died. Run on a
 * schedule per provider; also invoked by the conformance suite's crash test.
 * A destroy failure never aborts the sweep — it's reported and retried on
 * the next pass.
 */
export async function reapOrphans(
  provider: SandboxProvider,
  options: ReapOptions,
): Promise<ReapReport> {
  const sink = safeSink(options.eventSink ?? NOOP_SINK);
  const now = options.now ?? Date.now;
  const all = await provider.list();
  const report: ReapReport = { inspected: all.length, destroyed: [], failures: [] };
  for (const sandbox of all) {
    const age = now() - Date.parse(sandbox.createdAt);
    if (age <= options.ttlMs) continue;
    try {
      await provider.destroy(sandbox);
      report.destroyed.push(sandbox);
      sink.emit({
        type: "reaper_destroyed",
        providerId: provider.id,
        ts: new Date().toISOString(),
        sandboxId: sandbox.id,
        envKey: sandbox.envKey,
        meta: { ageMs: age },
      });
    } catch (err) {
      report.failures.push({
        sandbox,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}
