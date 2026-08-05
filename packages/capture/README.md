# @outerlayer/capture

Tolerant Claude Code transcript parser + copy-out daemon. Turns the
undocumented `~/.claude/projects/**/*.jsonl` files into validated
[`@outerlayer/session-schema`](../session-schema) `AgentSession`s. Zero
network — verified by test.

## What's here

- **`parseTranscript(content, opts)`** — line-by-line JSONL → `AgentSession`,
  following the transcript-to-session mapping that
  [`@outerlayer/session-schema`](../session-schema) defines. Never throws on
  content: malformed lines skip with a warning, unknown line types route to
  `vendor`, a future writer version parses best-effort with
  `version_newer_than_supported`. Validated against a real ~9.1k-session
  corpus (100% parse, no throw, 19 writer versions).
- **Cache-aware pricing** — `resolvePrice`/`costOfUsage` over a vendored,
  offline model-price table (1287 models, 412 cache-aware; regenerate with
  `yarn gen:prices`). Unknown model → `costUsd: null` + an
  `unknown_model_cost` warning, never a silent guess. The four token classes
  (input/output/cache-read/cache-create) are priced separately — cache-read
  dominates Claude Code cost and must never be collapsed.
- **`tailTranscript(file, checkpoint)`** — incremental parse whose core
  correctness property is *incremental == full*: re-parsing from any
  checkpoint yields a byte-identical session (a half-written final line is
  invisible until its newline lands). Idempotent — an unchanged file reports
  `advanced: false`, so the daemon never double-emits.
- **`CaptureDaemon`** — chokidar watch + periodic rescan mirroring transcripts
  to `~/.outerlayer/raw` **before** Claude Code's 30-day auto-deletion. Atomic
  (temp + rename), append-aware, LRU-evicted at a byte cap, include/exclude
  project filters. Survives the deletion race (tested): a mirrored session is
  still scannable after its source is gone.
- **`scanAll(opts)`** — backfill sweep unioning the live store and the raw
  mirror by session id (raw wins when Claude Code already cleaned its copy).

## Usage

```ts
import { scanAll, CaptureDaemon, parseTranscript } from "@outerlayer/capture";

// one-shot backfill of everything on disk
const { report, sessions } = scanAll();
console.log(`${report.parsed} sessions, warnings:`, report.warnings);

// keep raws safe from the 30-day cleanup
await new CaptureDaemon().start();
```

## Warning codes

Every parse warning is one of a documented, stable set:
`unknown_line_type`, `malformed_line`, `truncated_final_line`,
`version_newer_than_supported`, `ambiguous_timezone`, `unknown_model_cost`.
`parseTranscript` returns a histogram for `--verbose` reporting.

## Regenerating the price table

```bash
yarn gen:prices   # re-reads the model-registry snapshot, rewrites data/model-prices.json
```
