import type { Tables } from "@/types/db";

/** The list projection — never the digest, which never leaves `private.management_api_key_secret`. */
export type ManagementApiKeyRow = Omit<Tables<"management_api_key">, "tenant_id">;

export type CreateManagementApiKeyOutcome =
  | { ok: true; apiKey: string }
  | { ok: false; message: string };

export type RevokeManagementApiKeyOutcome = { ok: true } | { ok: false; message: string };
