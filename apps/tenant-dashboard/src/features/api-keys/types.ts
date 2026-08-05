import type { Tables } from "@/types/db";
import type { EntitlementDeniedInfo } from "@/config/entitlements";

export type ApiKeyRow = Tables<"api_key">;

export interface LoadApiKeysResult {
  apiKeys: ApiKeyRow[];
  environmentName?: string;
  /** The selected env could not be resolved — the page renders a fail-closed warning, never an unfiltered list. */
  unresolved?: boolean;
}

export type CreateApiKeyOutcome =
  | { ok: true; apiKey: string }
  | { ok: false; errorCode: "entitlement_denied"; message: string; entitlement: EntitlementDeniedInfo }
  | { ok: false; errorCode: string; message: string };

export type DeleteApiKeyOutcome = { ok: true } | { ok: false; message: string };

export type UpdateApiKeyOutcome = { ok: true } | { ok: false; message: string };

export interface DeleteApiKeyLookup {
  appId: string;
  tenantId: string;
  name: string;
  permissions: string[] | null;
}

export interface UpdateApiKeyLookup {
  id: string;
  tenantId: string;
  name: string;
  permissions: string[] | null;
}
