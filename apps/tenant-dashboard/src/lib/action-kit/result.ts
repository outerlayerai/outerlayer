/**
 * The result contract every Server Action returns.
 *
 * A discriminated union — never throw across the action boundary. The action
 * wrapper maps validation failures, permission denials, and thrown handler
 * errors all into a `fail(...)`, so callers branch on `result.ok` instead of
 * try/catch and there is no leaked exception surface to the client.
 */

/**
 * Stable error codes the action wrapper emits. Callers branch on these. They
 * live in this dependency-free module (not next to the wrapper, whose
 * dependency graph is server-only) so client code can branch on a code
 * without pulling server modules into its bundle.
 */
export const ActionErrorCodes = {
  VALIDATION: 'validation_error',
  FORBIDDEN: 'forbidden',
  INTERNAL: 'internal_error',
  UNAUTHENTICATED: 'unauthenticated',
} as const;

/** A structured, serializable error. `fieldErrors` mirrors zod's flattened shape. */
interface ActionError {
  /** Stable, machine-branchable code (see `ActionErrorCodes`). */
  code: string;
  /** Human-readable summary; safe to surface. */
  message: string;
  /** Per-field validation messages, keyed by input field. Present on validation failures. */
  fieldErrors?: Record<string, string[] | undefined>;
}

/** Success carries `data`; failure carries a structured `error`. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

/** Wrap a successful value. */
export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/** Wrap a failure. Widened to `ActionResult<never>` so it unifies with any `ActionResult<T>`. */
export function fail(error: ActionError): ActionResult<never> {
  return { ok: false, error };
}
