# outerlayer

Capture what your coding agents actually did, and sync it to your OuterLayer
cloud workspace.

OuterLayer captures the sessions your coding agents already write to disk
(Claude Code, Codex CLI, Cursor) and syncs them to your OuterLayer cloud
workspace, where you and your team can see what your agents did across every
repo. Capture is local and passive; nothing uploads until you run `sync`.

```
npx outerlayer init          # install the capture hooks
npx outerlayer sync --dry-run # see exactly what would leave your machine
npx outerlayer sync           # upload to your cloud workspace
```

## Privacy, stated plainly

**Nothing leaves your machine unless you run `sync`.** Capture — the `<50ms`
hook and the `watch` daemon — makes zero network calls, enforced by a test,
not a promise: every outbound TCP connection in the test suite funnels through
an assertion that none happen.

`outerlayer sync` is the one explicit opt-in that uploads — to YOUR
OuterLayer cloud workspace, with an API key you minted. Two guarantees:

- **The tier is applied before anything leaves.** The default tier is
  `redacted`: message text, thinking, images, and tool input/output are
  stripped client-side; only structure (repos, branches, file paths, tool
  names, error signatures) and metrics ship. `--tier metrics` strips
  identifiers too; `--tier full` ships content (the server additionally clamps
  to your org's configured ceiling — sending more than it allows stores less).
- **`--dry-run` shows exactly what would leave** — per-session rows, image
  bytes, and the precise field classes stripped at the chosen tier. Add
  `--json` to inspect the literal request payloads. Zero network calls.

## Commands

| Command | What it does |
|---|---|
| `outerlayer sync` | Upload sessions to your OuterLayer cloud workspace (incremental — only what's new since the last sync). Tier-gated client-side (`--tier metrics\|redacted\|full`, default `redacted`); `--dry-run` prints exactly what would leave the machine; `--all` re-sends everything (idempotent server-side). Credentials via `--url/--api-key/--app-id`, `OUTERLAYER_*` env vars, or `~/.outerlayer/config.json`. |
| `outerlayer init` | Install the capture hook + daemon so new sessions are preserved automatically (Claude Code deletes transcripts after ~30 days; the daemon mirrors them first). |
| `outerlayer watch` | Run the copy-out daemon in the foreground (`--once` for a single sweep). |
| `outerlayer doctor` | Check the installation: hooks, daemon heartbeat, and sync health. |

## Status line

`init` also adds an ambient Claude Code status-line segment showing what your
session and your agents are costing today:

```
⬢ OL  $0.87 session · $23.40 today across 3 agents · 12 unsynced
```

The session figure comes straight from Claude Code's own cost field, so it
always matches what Claude Code itself would show. The cross-agent total and
unsynced count come from `~/.outerlayer/statusline.json`, a small file the
`watch` daemon keeps fresh — the status line itself never parses transcripts,
so it stays well under Claude Code's refresh budget.

If a `statusLine` command is already configured, `init` **wraps it rather
than replacing it**: your existing command's output is printed first, the
OuterLayer segment appends after. A hang or failure in the wrapped command
never blanks the line — it times out and OuterLayer's segment prints alone.
`outerlayer init --remove` restores the original command exactly.

Without `outerlayer watch` running, the line degrades gracefully to the
session figure alone plus a dim `outerlayer doctor` hint — run `outerlayer
doctor` to see why (usually: the daemon isn't running, or hasn't refreshed
recently).

Opt out of the segment with `outerlayer init --no-statusline`.

## Supported agents

| Agent | Source | Status |
|---|---|---|
| Claude Code | `~/.claude/projects` (+ raw mirror) | full: turns, tool I/O, thinking, images, subagents, cost |
| Codex CLI | `~/.codex/sessions` | full: turns, tool I/O, edits (apply_patch), errors, usage |
| Cursor | `~/.cursor/chats` | turns, thinking, tool I/O, edits, errors — no cost (Cursor stores no token usage) |

Sessions from every agent land in one canonical schema
(`@outerlayer/session-schema`), so sync and everything downstream treat them
identically. Adding an agent is one source adapter.

## How capture works

Your agents already write complete transcripts to disk — OuterLayer treats
those as the source of truth rather than wrapping or proxying the agent:

- **`init`** adds a <50ms hook that notes each session event and a daemon
  that mirrors transcripts before the agent deletes them — so history
  survives even for agents with retention windows.
- **`sync`** parses whatever is on disk and ships it to your cloud workspace,
  incrementally, only what's new since the last run.

No API keys, no model calls, no interception. If you uninstall OuterLayer,
your agents never notice.

## Requirements

Node 22+. macOS and Linux; Windows untested (issues welcome). Capturing
**Cursor** sessions additionally needs Node 22.5+ (it reads Cursor's SQLite
chat store via the `node:sqlite` builtin); on older Node, Cursor is skipped and
Claude Code / Codex still sync.
