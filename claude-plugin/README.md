# OuterLayer plugin for Claude Code

Captures Claude Code sessions for the [OuterLayer](https://github.com/outerlayerai/outerlayer)
dashboard — the same lifecycle hooks `outerlayer init` installs, packaged so
enabling the plugin is the whole setup.

## What it does

- Registers hooks for `SessionStart`, `SessionEnd`, and `Stop` (deliberately
  not Pre/PostToolUse: transcripts already carry tool data, and per-tool hooks
  add latency for zero marginal signal).
- Each hook runs a small launcher (`scripts/hook.mjs`) that executes the
  [`outerlayer`](https://www.npmjs.com/package/outerlayer) CLI from a
  self-managed install under `~/.outerlayer/cli`, refreshed automatically in
  the background. All capture logic lives in the npm package; the plugin
  carries none.
- On a fresh machine the first hook invocation starts a background install;
  capture is live from the first completed install onward — no manual
  `outerlayer init` or `npx` step.

## Failure posture

Hooks always exit 0. CLI not yet installed, npm unavailable, offline, corrupt
install — every failure is swallowed and never surfaces into your session.
Events that fire before the CLI is installed are dropped; the transcript
still exists on disk, so nothing is lost once capture starts.

## Coexistence with `outerlayer init`

If this machine also has hooks installed by `outerlayer init`, both fire, and
the CLI deduplicates per session-event so nothing is captured twice. The
settings-file copy is redundant with the plugin enabled — remove it with:

```sh
outerlayer init --remove
```

`outerlayer doctor` reports which install path is active.

## Uninstall

Disable (or uninstall) the plugin — its hooks stop firing immediately and the
plugin leaves nothing behind in your Claude Code settings. Captured data and
the managed CLI live under `~/.outerlayer/`; delete that directory to remove
every trace.
