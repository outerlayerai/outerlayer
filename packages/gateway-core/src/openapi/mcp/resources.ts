/**
 * The `outerlayer://guide` MCP resource — static reference text an MCP
 * client can read once and hold in context so tool calls need no further
 * clarification about the domain model or the semantics the tool
 * descriptions gesture at but don't have room to spell out in full.
 */

export const GUIDE_RESOURCE_URI = 'outerlayer://guide';

export const GUIDE_RESOURCE_TEXT = `# OuterLayer data model — MCP guide

## Sessions, traces, and spans

A **session** is one agent-coding run — from the first user turn to the
last — identified by its trace id. A session's **spans** are the individual
tool calls, model generations, and sub-steps recorded inside it. A session
whose work fans out into a subagent produces a separate transcript; its
spend and span count are NOT folded into the parent session's own totals,
but the SESSION COUNT on a topic credits the root session once even when
subagents fan out under it.

## Facets and topics

A **facet** buckets sessions along one dimension: \`task\` (what the agent
was asked to do), \`issues\` (problems it ran into), or \`steering\`
(corrections the user gave mid-session). A **topic** is one cluster within
a facet's active map — \`list_topics(facet, limit)\` returns the largest
topics by session count. Drill into one topic's sessions with
\`list_sessions(topicId, topicFacet)\`.

## Snapshot vs. live fields

On a topic entry, \`sessionCount\`, \`share\`, and \`trend\` are LIVE — they
include sessions classified after the topic map was generated. \`avgLatencyMs\`,
\`avgCostUsd\`, and \`errorRate\` are SNAPSHOTS computed once at generation time
(as of \`generatedAt\`) over a sample of member sessions — they do not move as
new sessions are classified into the topic.

## Cost semantics

Every cost figure (\`get_model_costs\`, a topic's \`avgCostUsd\`, a fleet
tile's \`totalCost\`) is METERED LLM SPEND for the queried app only — token
cost billed by the model provider. It excludes seat/subscription cost and
any other app's spend. \`get_model_costs\` windows are UTC calendar dates.

## Actor privacy

\`list_sessions\` and \`get_session\` run under the calling key's privacy
scope: without \`agents.sessions.team.read\`, actor identities are
anonymized (a fixed placeholder name) and an \`actorId\` filter is rejected.
A key with that permission sees real actor names.

## Comparing before/after a change

Neither tool takes an implicit "compare" mode — call \`get_fleet_overview\`
(or \`get_model_costs\`) twice with two explicit, non-overlapping \`from\`/\`to\`
windows and compare the two results yourself. \`get_fleet_overview\` also
returns its own \`prior\` period, which is the immediately preceding
equal-length window — use that when you want "vs. right before this window"
rather than a specific comparison window.

## Truncation

\`get_session\` caps its span list (the SQL layer keeps at most 2000 spans)
and additionally caps its own serialized output size. Either cap sets
\`truncated: true\` on the response; when truncated you have the session's
FIRST spans, not necessarily its last — call \`GET /v1/sessions/{traceId}\`
over REST with pagination if you need spans past the cap.
`;
