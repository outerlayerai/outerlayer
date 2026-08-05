// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Per-sandbox lifecycle telemetry. The SLO pipeline consumes
 * these; locally they feed cost/duration accounting. Sinks must never throw
 * into the provider path.
 */
export interface LifecycleEvent {
  type:
    | "env_prepared"
    | "sandbox_created"
    | "sandbox_destroyed"
    | "exec_completed"
    | "reaper_destroyed";
  providerId: string;
  ts: string;
  sandboxId?: string;
  envKey?: string;
  durationMs?: number;
  meta?: Record<string, string | number | boolean>;
}

export interface EventSink {
  emit(event: LifecycleEvent): void;
}

export const NOOP_SINK: EventSink = { emit: () => undefined };

/** Buffering sink for tests and local accounting. */
export class MemorySink implements EventSink {
  readonly events: LifecycleEvent[] = [];
  emit(event: LifecycleEvent): void {
    this.events.push(event);
  }
  ofType(type: LifecycleEvent["type"]): LifecycleEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** Wrap a sink so a throwing sink can never break sandbox operations. */
export function safeSink(sink: EventSink): EventSink {
  return {
    emit(event) {
      try {
        sink.emit(event);
      } catch {
        // telemetry must never take down the runner
      }
    },
  };
}
