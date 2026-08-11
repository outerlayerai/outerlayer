# Headless REST API + MCP Server — Acceptance Criteria

REST endpoints and an MCP server for topics, sessions, and fleet metrics —
programmatic access to what the dashboard already renders, for headless
agents and chat connectors.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## REST endpoints

1. `AC-052-01` **Given** a valid app-bound API key with `metrics.read`, **When** `GET /v1/topics?facet=issues&limit=3` is called, **Then** the top 3 issue topics by session count are returned with name, session count, and share.
2. `AC-052-02` **Given** a topic id from the active map, **When** `GET /v1/sessions?topicId=…&topicFacet=issues` is called, **Then** only sessions whose trace (or subagent transcript) matched that topic are returned, and the total equals the Topics view's session count for that topic.
3. `AC-052-03` **Given** a session's trace id, **When** `GET /v1/sessions/{traceId}` is called with a key from another app, **Then** the response is the same 404 as for a nonexistent id.
4. `AC-052-04` **Given** seeded generation spans with known per-model costs in a window, **When** `GET /v1/metrics/models` is called for that window, **Then** the response equals the precomputed fixture totals exactly.
5. `AC-052-05` **Given** a key without `agents.sessions.team.read`, **When** `GET /v1/sessions` is called, **Then** sessions are returned with actor identities anonymized and `actorId` filters rejected; **Given** a key with it, real identities are returned.

## MCP server

6. `AC-052-06` **Given** an MCP client authenticated with an API key, **When** it lists tools, **Then** the five read tools and the guide resource are advertised with schemas matching the REST contracts.
7. `AC-052-07` **Given** the MCP `list_topics` tool is called with `facet: "issues", limit: 3`, **Then** its result equals the REST `GET /v1/topics` response body for the same parameters.
8. **Given** the self-hosted Node gateway with Supabase-backed auth, **When** the same endpoints/tools are exercised, **Then** they behave identically to hosted (modulo rate limits, which are noop; OAuth is unavailable under `SELF_HOST_TRUST_PERIMETER` and documented as such).

## Authorization

9. **Given** an API key with only `trace.write` (the `sdk` preset), **When** any of the five new endpoints is called, **Then** the response is a structured 403 — and a `read-only`-preset key succeeds on all five.
10. `AC-052-10` **Given** the gateway permission registry, **When** the permission-liveness test runs, **Then** every grantable permission is required by at least one registered route or sits on the commented RLS-only allowlist.
11. `AC-052-11` **Given** an MCP request authenticated with an API key and **no** `X-Outerlayer-App-Id` header, **When** a tool is called, **Then** execution is scoped to the key's bound app as read from the resolved identity (never the raw header), and a header naming a different app is rejected.
12. **Given** an unauthenticated request to `/v1/mcp`, **When** the OAuth flow is followed from the 401's `WWW-Authenticate` metadata through dynamic registration, consent, and token exchange, **Then** the issued token calls tools successfully — and deleting the grant row makes the next call 401.

## Resource bounds

13. `AC-052-13` **Given** a session whose trace exceeds the span cap, **When** `GET /v1/sessions/{traceId}` is called, **Then** the response is capped at the SQL layer, flagged `truncated: true`, and returns within the Worker CPU budget.
14. `AC-052-14` **Given** a session-detail response containing blob references, **When** a blob URL is fetched after its expiry, **Then** access is denied — raw sha256 fetch without a signed URL is not possible via the session surface.
