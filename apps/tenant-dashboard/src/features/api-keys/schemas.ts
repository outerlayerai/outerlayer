import { z } from "zod";

export const createApiKeyInput = z.object({
  name: z.string(),
  appId: z.string(),
  permissions: z.array(z.string()).optional(),
  /** Env this key binds to. Omitted (non-kind-scoped) falls back to the app's default env. */
  environmentId: z.string().optional(),
  /** Kind-scoped keys carry no single env pin — see `allowedEnvKinds` in `mintApiKeySystem`. */
  allowedEnvKinds: z.array(z.string()).optional(),
});

export const deleteApiKeyInput = z.object({
  id: z.string(),
});

export const updateApiKeyPermissionsInput = z.object({
  apiKeyId: z.string(),
  appId: z.string(),
  permissions: z.array(z.string()),
});
