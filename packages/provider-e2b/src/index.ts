// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export {
  E2BProvider,
  type E2BProviderOptions,
  type E2BApi,
  type E2BSandboxHandle,
  type E2BListedSandbox,
  type E2BCreateOpts,
} from "./e2b-provider.js";

/**
 * Feature-flagged factory (spec: gate anything off during migration). Returns
 * null unless OUTERLAYER_E2B_ENABLED is set AND E2B_API_KEY is present — so the
 * managed provider never engages by accident. Routing calls this;
 * a null result falls back to the local provider.
 */
import { E2BProvider } from "./e2b-provider.js";

export function e2bProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): E2BProvider | null {
  if (env.OUTERLAYER_E2B_ENABLED !== "1") return null;
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) return null;
  return new E2BProvider({
    apiKey,
    ...(env.OUTERLAYER_E2B_TEMPLATE ? { template: env.OUTERLAYER_E2B_TEMPLATE } : {}),
  });
}
