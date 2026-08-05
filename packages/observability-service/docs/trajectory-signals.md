# Trajectory signals

Per-session signals describing **how a coding-agent session ran** — the path,
not the outcome. All of them are deterministic derivations over existing
telemetry (`agent_session_summary` counters and `otel_traces` span sequences);
no LLM sits in the signal path, and no schema changes were needed to compute
them. They are the ingredients for any future composite trajectory score:
ship the ingredients visibly first, compose only once they've been validated
against real fleets.

## Naming rule

Deterministic signals are named after the **observable event**, never an
interpretation: a counter can prove "the human typed again", not "the agent
went wrong", so its name must not claim the latter. Interpretation-bearing
names are reserved for signals whose classification actually carries the
evidence — see **corrections** under Future signals. One word means one thing
on every surface; the fleet form of a signal is always the session noun plus
rate/mean, never a new synonym. Display names follow this rule; persisted
wire identifiers (column names, metric ids, event types) keep their stored
names and are noted per signal.

## The signal set

| Signal | Definition | Source (wire name) |
|---|---|---|
| **Follow-ups** | `greatest(UserTurnCount − 1, 0)` — human turns beyond the initial ask. The first user turn is the task hand-off; every later one counts, whatever its reason: a correction, an answer to the agent's question, and a new task are all follow-ups. This measures human attention consumed, NOT agent error. | `agent_session_summary.UserTurnCount` |
| **Hands-on** | The binary form: the session had any follow-up (`UserTurnCount > 1`). Fleet grain: hands-on rate / hands-on share. | derived |
| **Denials** | Tool calls a human rejected at a permission prompt. Disjoint from tool errors. | `agent_session_summary.RejectedToolCallCount` |
| **Tool-error rate** | `ErrorCount / ToolCallCount`; `0` when the session made no tool calls. Same definition and divide-by-zero rule everywhere it appears (sessions list, session detail, fleet dashboards) so one session never shows two numbers. | `agent_session_summary.ErrorCount`, `.ToolCallCount` |
| **Permission prompts** | Permission prompts the session raised (`permission_prompt` session events). A count, not a duration — prompt-to-response latency is not derivable from the rollup and is deliberately out of scope here. Never shortened to "prompts" (collides with the user's prompt). | `agent_session_summary.PermissionPromptCount` |
| **Provider errors** | `api_error` session events — the model provider failing (rate limits, overload), not the agent's own actions. Distinct from tool errors (the agent's calls failing) and denials (a human saying no). | `agent_session_summary.ApiErrorCount` |
| **Edit loop** | ≥3 consecutive failed edits to one file with no success in between — the stuck-retry pattern. Needs the span *sequence*, so it's computed from `otel_traces` rows on the session detail only, never at list/fleet grain. Same definition and threshold as the `edit-retry-loop` findings detector. | `otel_traces` tool spans (`Metadata.isEdit`, `Metadata.file`, error status) |
| **Clean** | None of the above fired: `UserTurnCount ≤ 1 AND RejectedToolCallCount = 0 AND ErrorCount = 0 AND ApiErrorCount = 0`. Reserved for this full conjunction; the tool-error-only fleet floor stays labeled "error-free rate". | derived |

## Scoping rules

- **Interactive origins.** Human-behavior rates (denial rate, hands-on share,
  mean follow-ups) are only meaningful over sessions a human drives:
  `Origin IN ('', 'interactive')`. SDK/headless runs (`agent`) and cloud
  worker runs (`worker`) auto-approve by construction — their extra "user"
  turns and denials are programmatic, and counting them dilutes the signal.
  Legacy rows (`Origin = ''`, ingested before origin classification) count as
  interactive. Tool-error rate is quality truth for the whole fleet and stays
  origin-blind.
- **Rates carry their denominators.** Every rate is `numerator ÷ denominator`
  with a stated zero rule (`0` when the denominator is zero). Never surface a
  rate without knowing which population it's over.
- **Sessions vs. traces.** `agent_session_summary` is one row per trace;
  subagents and resumed runs write extra rows. Per-session filters and sorts
  on the sessions list operate on top-level rows (`ParentSessionId = ''` by
  default). Fleet aggregates that claim session grain group by the root
  session first (`ROOT_SESSION_KEY` in `queries-agent-fleet.ts`).
- **Pre-migration rows read zero.** Rows ingested before the steering columns
  existed carry `0` in the counters. Zero means "nothing observed", which for
  old rows may be "nothing recorded" — trends starting before the columns
  landed under-count, they don't fabricate.

## Where each surfaces

- **Session detail** (`/api/agents/sessions/{traceId}`): the full signal set —
  follow-ups, denials, permission prompts, provider errors, tool-error rate,
  and the edit-loop pattern from the span sequence.
- **Sessions list** (`/api/agents/sessions`): sortable `steering` (wire name;
  displays as Follow-ups, backed by `UserTurnCount`) and `toolErrorRate`
  columns; the `signal` filter buckets
  (`hands-on | denied | tool-errors | provider-errors | clean`) — closed
  predicates in `SIGNAL_PREDICATES`, composing with every other filter. The
  filter's UI label is **Trajectory**, so the family name is visible on the
  surface where you filter by it.
- **Fleet dashboards**: the `agent_trajectory_signals_trend` metric (daily
  tool-error rate, denial rate, hands-on share), the
  `agent_interventions_trend` metric (wire name; displays as Follow-ups per
  Session), and the hands-on / denial / auto-approve tiles — all reading the
  same definitions above.

## Future signals (names reserved)

- **Corrections** — corrective follow-ups only: the steering facet's
  `rule` and `preference` classifications, excluding `task_direction` (a new
  line of work) and `question` (an answer to the agent's own ask). This is
  the signal allowed to carry an interpretive name, because an LLM classified
  the turn — which also means partial coverage (enriched sessions only) and a
  model in the signal path, so it surfaces alongside follow-ups, never
  silently replacing them. Gate on validating, against real fleet data, how
  far raw follow-ups over-count corrections before building composites on
  either.
