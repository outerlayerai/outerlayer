/**
 * Canonical gateway error envelopes.
 *
 * Neutral module: it imports only `@repo/api-schemas`, so BOTH the routes layer
 * and the runtime layer (`runtime/`, `routes/`) can build a structured error
 * without importing from `openapi/routes/_shared`. `structuredError` lives here
 * rather than in the routes layer so the runtime never has to import from
 * routes, which would invert the layering.
 *
 * `openapi/routes/_shared.ts` re-exports these, so a route may import
 * `structuredError` from either place.
 */

import {
  structuredError as sharedStructuredError,
  type ErrorEnvelope,
} from '@repo/api-schemas';

/**
 * The closed set of gateway error codes. Pinning the `code` arg of
 * `structuredError` to this union gives compile-time prevention of code-drift
 * (e.g. `not_found_trace` vs `trace_not_found`).
 */
export type GatewayErrorCode =
  // Resource lookup failures (404)
  | 'trace_not_found'
  | 'span_not_found'
  | 'blob_not_found'
  | 'score_not_found'
  | 'api_key_not_found'
  | 'api_key_creation_failed'
  | 'api_key_revoke_failed'
  | 'duplicate_api_key_name'
  // Deployments
  | 'deployment_not_found'
  // Cloud workers
  | 'worker_run_not_found'
  | 'worker_session_not_found'
  | 'worker_session_destroyed'
  | 'worker_environment_busy'
  | 'worker_dispatch_failed'
  | 'worker_dispatch_unconfigured'
  | 'unknown_worker_agent'
  // Alerts
  | 'alert_not_found'
  | 'duplicate_alert_name'
  | 'slack_api_error'
  // Apps
  | 'app_not_found'
  | 'duplicate_app_name'
  | 'git_connect_not_configured'
  | 'git_connection_missing'
  | 'repo_branch_already_linked'
  | 'unsupported_git_provider'
  | 'webhook_registration_failed'
  // Evidence emits (artifacts + emitted results): emit-time failures.
  // `session_not_found` (400) rejects a session binding whose session never
  // synced; `nothing_to_attach` (400) rejects an emit with no anchor (for
  // artifacts: no session, PR, or git context; for emitted results: no
  // resolvable repository); `artifact_content_conflict` (409) rejects a
  // clientArtifactId retry whose content differs from the stored artifact
  // instead of silently dropping it.
  | 'session_not_found'
  | 'nothing_to_attach'
  | 'artifact_content_conflict'
  // Tier-gated features (402 Payment Required)
  | 'entitlement_required'
  // Request validation failures (400 / 422)
  | 'invalid_request_body'
  | 'invalid_field_value'
  | 'invalid_filter'
  | 'missing_required_field'
  | 'missing_body'
  | 'missing_extension'
  | 'unsupported_content_type'
  | 'payload_too_large'
  // Payload processing failures (400 / 500)
  | 'gzip_decompression_failed'
  // Billing / quota enforcement (429)
  | 'span_limit_exceeded'
  | 'storage_cap_exceeded'
  // ClickHouse / analytics layer (observability-service `toErrorResponse`)
  | 'query_timeout'
  | 'service_unavailable'
  | 'validation_error'
  | 'not_found'
  | 'forbidden'
  | 'internal_error'
  // Auth / availability
  | 'unauthorized'
  | 'not_implemented'
  | 'not_available_on_cloud'
  | 'not_available_locally'
  // Env resolution: emitted when a request supplies an envName that can't be
  // resolved (or no envId/envName and the app has no default env).
  | 'env_not_found'
  // Environments & Promotion. Emitted from
  // routes/environments.ts and the supporting services. Codes cover the
  // env CRUD surface, promote/rollback saga errors, and Fly provisioning.
  | 'env_name_invalid'
  | 'env_name_conflict'
  | 'env_limit_exceeded'
  | 'env_default_cannot_delete'
  | 'env_confirmation_mismatch'
  | 'env_entitlement_limit_reached'
  | 'env_promote_source_equals_target'
  | 'env_promote_source_not_found'
  | 'env_promote_target_not_found'
  | 'env_promote_target_is_default'
  | 'env_promote_ephemeral_not_allowed'
  | 'env_promote_no_git_connection'
  | 'env_promote_branch_not_resolvable'
  | 'env_promote_no_pinned_source'
  | 'env_promote_source_deployment_missing'
  | 'env_promote_prompts_path_missing'
  | 'env_promote_commit_unreachable'
  | 'env_rollback_version_not_found'
  | 'env_rollback_version_not_success'
  | 'env_rollback_target_not_found'
  | 'env_saga_not_found'
  | 'env_saga_not_retryable'
  | 'env_fly_provisioning_failed';

/**
 * Back-compat alias: existing gateway call sites type their bodies as
 * `StructuredErrorBody`, but the underlying shape is the shared `ErrorEnvelope`.
 */
export type StructuredErrorBody = ErrorEnvelope & {
  error: { code: GatewayErrorCode };
};

/**
 * Build an error envelope. Thin typed wrapper over `@repo/api-schemas`'s
 * `structuredError` that pins the code to `GatewayErrorCode` at the gateway call
 * site. Runtime shape is identical to what the OSS CLI emits, so consumers see
 * one envelope regardless of which side they hit.
 */
export function structuredError(
  code: GatewayErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
): StructuredErrorBody {
  return sharedStructuredError(code, message, extras) as StructuredErrorBody;
}
