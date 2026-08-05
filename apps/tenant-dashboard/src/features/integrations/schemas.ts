import { z } from "zod";

import { ENV_VAR_TARGET_KINDS } from "@repo/env-kind";


/**
 * Targeting scope for an env-var write: EITHER a specific environment OR a
 * kind. Mirrors the `env_var` exactly-one-of
 * (environment_id, target_kind) CHECK constraint at the schema level, so an
 * invalid scope is rejected before any Vault or DB call.
 */
const envVarScope = z.union([
  z.object({ environmentId: z.uuid(), targetKind: z.undefined().optional() }),
  z.object({
    targetKind: z.enum(ENV_VAR_TARGET_KINDS),
    environmentId: z.undefined().optional(),
  }),
]);

const envVarKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "Key must be uppercase letters, digits, and underscores, starting with a letter");

export const setEnvVarInput = z.object({
  appId: z.uuid(),
  scope: envVarScope,
  key: envVarKey,
  value: z.string().min(1),
});

export const setEnvVarForTargetsInput = z.object({
  appId: z.uuid(),
  scopes: z.array(envVarScope).min(1),
  key: envVarKey,
  value: z.string().min(1),
});

export const deleteEnvVarInput = z.object({
  appId: z.uuid(),
  envVarId: z.uuid(),
});

export const revealEnvVarInput = z.object({
  appId: z.uuid(),
  envVarId: z.uuid(),
});
