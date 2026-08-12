import type { Tables } from "@/types/db";

/** The list projection — never the digest, which never leaves `private.admin_api_key_secret`. */
export type AdminApiKeyRow = Omit<Tables<"admin_api_key">, "tenant_id">;

export type CreateAdminApiKeyOutcome =
  | { ok: true; apiKey: string }
  | { ok: false; message: string };

export type RevokeAdminApiKeyOutcome = { ok: true } | { ok: false; message: string };
