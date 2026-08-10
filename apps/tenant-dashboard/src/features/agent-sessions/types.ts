/**
 * Domain types for agent sessions — the wire shape of the list/detail
 * reads, shared by the service and the React Server Component (RSC) pages that call it.
 * Re-exported from `@repo/api-schemas`, which is where the gateway's future
 * `/v1/sessions` routes and the `list_sessions`/`get_session` MCP tools get
 * the same contracts — this file stays the dashboard's stable import path.
 */
export type {
  AgentSessionDetail,
  AgentSpan,
  SessionPrOutcome,
  SessionsPage,
  SessionsSort,
  SessionsSignal,
} from "@repo/api-schemas";
