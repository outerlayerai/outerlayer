// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export type {
  SandboxProvider,
  EnvSpec,
  EnvRef,
  Sandbox,
  SandboxInfo,
  SandboxOpts,
  ExecOpts,
  ExecResult,
  FileMap,
  NetworkMode,
} from "./types.js";
export { SANDBOX_LABELS, SandboxProviderError } from "./types.js";
export { LocalDockerProvider } from "./local-docker.js";
export type { LocalDockerProviderOptions } from "./local-docker.js";
export { FlyProvider } from "./fly.js";
export type { FlyProviderOptions } from "./fly.js";
export { reapOrphans } from "./reaper.js";
export type { ReapOptions, ReapReport } from "./reaper.js";
export { NOOP_SINK, MemorySink, safeSink } from "./events.js";
export type { EventSink, LifecycleEvent } from "./events.js";
// The conformance suite lives at `@outerlayer/runner-core/conformance` — it
// imports vitest (an optional peer) and must not ride in the runtime entry.
