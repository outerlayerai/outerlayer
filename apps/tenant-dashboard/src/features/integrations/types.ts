import type { EnvVarTargetKind } from "@repo/env-kind";

/**
 * Targeting scope for an env-var write/read: EITHER a specific environment OR
 * a kind. Mirrors the `env_var` exactly-one-of (environment_id,
 * target_kind) CHECK constraint at the type level. Shared between the schema
 * (`schemas.ts`), the service, and the client components that build scopes
 * from a picker selection.
 */
export type EnvVarScope =
  | { environmentId: string; targetKind?: undefined }
  | { targetKind: EnvVarTargetKind; environmentId?: undefined };

/** An env-var row, listed without its secret value. */
export interface EnvVarListItem {
  id: string;
  key: string;
  created_at: string;
  updated_at: string | null;
}

/** A full env-var row as listed for the app-level management UI. */
export interface EnvVarRecord {
  id: string;
  key: string;
  environment_id: string | null;
  target_kind: EnvVarTargetKind | null;
  created_at: string;
  updated_at: string | null;
}
