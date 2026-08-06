/**
 * Canonical error codes emitted by the dashboard API.
 *
 * Shape and conventions mirror `GatewayErrorCode` in
 * `apps/gateway/src/openapi/routes/_shared.ts`:
 *   - snake_case, per-resource ("dashboard_not_found", not "not_found")
 *   - grouped by lifecycle (lookup / validation / auth / infra)
 *   - closed union — compile-time check on `structuredError()` prevents drift
 *
 * The shared/infra codes are pre-populated because the wrapper itself emits
 * them (any handler can hit 401/500). Resource-specific codes
 * are owned by the route family that emits them — add as routes are
 * migrated, remove as they become unreachable.
 *
 * Two naming conventions to choose between:
 *   - Per-resource:  "dashboard_not_found"  "widget_not_found"  "queue_not_found"
 *   - Generic + ctx: "not_found"            (with { resource: "dashboard" } extras)
 *
 * The gateway chose per-resource — more self-describing to API consumers,
 * easier to switch on in client code. This file assumes that convention.
 */

export type DashboardErrorCode =
  // -----------------------------------------------------------------------
  // Shared / infrastructure — emitted by the wrapper itself, not routes.
  // Do not remove these without first auditing `with-api.ts`.
  // -----------------------------------------------------------------------
  | 'unauthorized'               // Session missing or expired
  | 'forbidden'                  // Authenticated but lacks tenant/app access
  | 'invalid_request_body'       // JSON parse failure or schema rejection
  | 'invalid_query_params'       // Query-string schema rejection
  | 'invalid_path_params'        // Path-param schema rejection
  | 'missing_required_field'     // Required field absent from a valid JSON body
  | 'invalid_field_value'        // Field present but violates a value constraint
  | 'internal_error'             // Uncaught / unmapped error
  | 'service_unavailable'        // Upstream dependency (CH, Supabase) down
  // -----------------------------------------------------------------------
  // Dashboards + widgets.
  //
  // Per-resource convention, matching the gateway (`trace_not_found`,
  // `score_not_found`, …). Rationale: self-describing to API consumers,
  // easy to switch on in client code, no extras field parsing required.
  //
  // Extras conventions (documented here, enforced at the call site):
  //   - `dashboard_limit_exceeded` carries `{ scope: 'app' | 'org', limit }`
  //     so the UI can distinguish "upgrade plan" vs. "archive an old one"
  //     without parsing the message.
  //   - `widget_limit_exceeded` carries `{ dashboardId, limit }`.
  //   - `*_conflict` codes carry `{ field, value? }`.
  //   - Missing `templateId` → `invalid_field_value` with `{ field }`.
  // -----------------------------------------------------------------------
  | 'dashboard_not_found'
  | 'widget_not_found'
  | 'dashboard_name_conflict'      // 409 — unique (app_id, name) violation
  | 'widget_title_conflict'        // 409 — unique (dashboard_id, title) violation
  | 'dashboard_limit_exceeded'     // 429 — per-app or per-org cap hit
  | 'widget_limit_exceeded'        // 429 — MAX_WIDGETS_PER_DASHBOARD hit
  // -----------------------------------------------------------------------
  // Saved filters (trace/request/session views).
  // Extras: `saved_filter_name_conflict` carries `{ field: 'name', page }`.
  // -----------------------------------------------------------------------
  | 'saved_filter_not_found'
  | 'saved_filter_name_conflict'   // 409 — unique (app_id, name, page) violation
  | 'saved_filter_limit_exceeded'  // 429 — MAX_FILTERS_PER_APP hit
  // -----------------------------------------------------------------------
  // Score analytics.
  //
  // `score_type_mismatch` fires on `/scores/comparison` when the two
  // scores the caller picked aren't type-compatible (e.g. one numeric,
  // one categorical). Comes back as a 400 with
  // `{ field: 'nameA'|'nameB' }` extras so the UI can highlight which
  // picker is wrong without re-parsing the message.
  // -----------------------------------------------------------------------
  | 'score_type_mismatch'
  // -----------------------------------------------------------------------
  // Session analytics.
  //
  // `session_not_found` fires on `/sessions/{id}/traces` when the
  // sessionId doesn't resolve (either missing from ClickHouse or zero
  // traces associated — the pre-migration handler treats both as 404).
  // -----------------------------------------------------------------------
  | 'session_not_found'
  // -----------------------------------------------------------------------
  // Experiments.
  //
  // `experiment_not_found` fires on `/experiments/{id}` when the id
  // doesn't resolve in ClickHouse.
  // -----------------------------------------------------------------------
  | 'experiment_not_found'
  // -----------------------------------------------------------------------
  // Dataset runs.
  //
  // `dataset_run_not_found` fires on `/datasets/{id}` when the run id
  // doesn't resolve. "Dataset run" = one execution of a dataset through
  // the experiment pipeline; distinct from the gateway's
  // `/v1/datasets/{name}` concept (the dataset file itself).
  // -----------------------------------------------------------------------
  | 'dataset_run_not_found'
  // -----------------------------------------------------------------------
  // Traces + spans.
  //
  // `trace_not_found` fires on `/traces/{id}` when the id doesn't resolve
  // in ClickHouse. `span_not_found` fires on `/traces/{id}/spans/{spanId}/io`
  // when the spanId isn't part of the trace (or the trace itself is gone).
  // Both 404 — the client shouldn't retry; the user navigated to a stale
  // permalink.
  // -----------------------------------------------------------------------
  | 'trace_not_found'
  | 'span_not_found'
  // -----------------------------------------------------------------------
  // Context layer (OuterLayer read-only UI).
  //
  // `context_file_not_found` fires when a requested file isn't part of the
  // resolved snapshot (stale permalink, or the file was removed in a later
  // sync). 404 — the client shouldn't retry.
  // -----------------------------------------------------------------------
  | 'context_file_not_found'
  ;
