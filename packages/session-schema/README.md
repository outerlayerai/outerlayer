# @outerlayer/session-schema

Agent-agnostic session schema (v1) — the contract between transcript capture,
the local session store and scan, the insight detectors, cloud ingest, and eval
trajectories. Every producer and consumer of an `AgentSession` agrees on the
shapes defined here.

## What's here

- **Zod schemas + inferred types** — `AgentSessionSchema`, `TurnSchema`,
  `ToolCallSchema`, `SessionEventSchema`, `ParseWarningSchema`; all objects
  are loose (unknown keys pass through) so additive writer changes survive
  older readers.
- **Capture tiers** — `metrics ⊂ redacted ⊂ full`. `FIELD_TIERS` is the
  single source of truth for field→minimum-tier; `downconvertSession()`
  strips a session to a target tier; `tierViolations()` audits one.
- **JSON Schema export** — `agentSessionJsonSchema()` (draft 2020-12),
  committed at `fixtures/agent-session.v1.schema.json`, tier annotations as
  `description: "tier:<min>"`.
- **Canonical serialization** — `canonicalStringify()` (sorted keys) — the
  byte-stability primitive golden tests build on.
- **Fixture corpus** — `fixtures/raw/`: 44 sanitized real Claude Code
  transcripts (stratified across writer versions 2.1.141–2.1.198, sizes,
  subagents, compactions, API errors…) + a synthetic future-version fixture
  with unknown line types and a truncated tail. Zero real content — enforced
  by `scripts/leak-scan.mjs`, which also runs in the test suite.

## Usage

```ts
import {
  parseAgentSession,
  downconvertSession,
  tierViolations,
  agentSessionJsonSchema,
  EVENT_TYPES,
} from "@outerlayer/session-schema";

const session = parseAgentSession(untrustedJson);        // throws ZodError on shape mismatch
const forCloud = downconvertSession(session, "redacted"); // strip content per FIELD_TIERS
tierViolations(forCloud, "redacted");                      // → [] (audited, not assumed)
```

Design rules writers/readers must follow:

1. Unknown input never throws — degrade into `vendor` + a `ParseWarning`.
2. Never collapse usage into a single token count (cache tokens dominate).
3. `costUsd: null` means "price unknown"; never guess silently.
4. `schemaVersion` stays `1` across additive changes.

## Scripts

| Command | Purpose |
|---|---|
| `node scripts/sample-and-sanitize.mjs` | regenerate the fixture corpus from a local `~/.claude/projects` history |
| `node scripts/leak-scan.mjs` | verify zero content in `fixtures/raw` (CI-safe, exit 1 on finding) |
| `node scripts/write-canonical-fixtures.mjs` | regenerate canonical examples + the committed JSON Schema (run after `yarn build`) |

## Stability

Additive-only within v1. Removals, renames, and semantic changes bump
`schemaVersion`.
