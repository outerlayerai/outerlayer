// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

// The hook fast-path is intercepted HERE, before any heavy import is
// evaluated (commander, capture, sqlite). `outerlayer hook <event>` must stay
// under a 50ms budget, so it may touch only node builtins.
const argv = process.argv.slice(2);
if (argv[0] === "hook") {
  const { runHookFast } = await import("./hook-fast.js");
  runHookFast(argv[1]);
  process.exit(0); // ALWAYS 0 — never disrupt Claude Code
}

// The hook-wrap fast-path (installed by `hooks wrap`) is intercepted here for
// the same reason: it must stay import-light. Unlike `hook` above, it runs a
// USER'S command and propagates that command's exit code verbatim — see
// hook-wrap-fast.ts for why this is a deliberate departure from always-0.
if (argv[0] === "hook-wrap") {
  const { runHookWrapFast, parseHookWrapArgs } = await import("./hook-wrap-fast.js");
  const { id, captureOutput } = parseHookWrapArgs(argv.slice(1));
  const code = await runHookWrapFast(id, { captureOutput });
  process.exit(code);
}

// Everything below is the normal (latency-insensitive) CLI.
const { runCli } = await import("./cli.js");
await runCli(process.argv);

export {};
