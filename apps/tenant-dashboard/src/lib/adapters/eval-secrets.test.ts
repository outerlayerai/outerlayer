/**
 * `readEvalConfigSecrets` — the eval run's secret-resolution bridge. Given an
 * app + environment + a config's launcher, it must read the RIGHT model key
 * from the environment's Vault-backed env vars, and refuse (not silently
 * proceed) when the key is unset.
 *
 * Test boundary per apps/tenant-dashboard/CLAUDE.md: the Supabase REST table
 * (`env_var`) and the vault RPC (`read_secret`) are faked via MSW
 * seed helpers — nothing here mocks the query builder. The service-role client
 * is constructed inside the bridge; the global setup points config-global at
 * the MSW-intercepted localhost URL, so it resolves against the seeded tables.
 */

import { readEvalConfigSecrets, EvalSecretsError } from "./eval-secrets";
import {
  seedManagedDeploymentTablesState,
  seedVaultMswState,
} from "@/test-helpers/msw-handlers";

const APP_ID = "app-1";
const ENV_ID = "11111111-1111-4111-8111-111111111111";

/** Seed a single decrypted env var for the env under test. */
function seedEnvVar(key: string, value: string) {
  seedManagedDeploymentTablesState({
    envVars: [{ id: `${key}-id`, app_id: APP_ID, environment_id: ENV_ID, key }],
  });
  seedVaultMswState({ secrets: { [`env_${APP_ID}_${ENV_ID}_${key}`]: value } });
}

describe("readEvalConfigSecrets", () => {
  it("resolves ANTHROPIC_API_KEY for a claude-code config from the env's Vault vars", async () => {
    seedEnvVar("ANTHROPIC_API_KEY", "sk-ant-real-key");
    const secrets = await readEvalConfigSecrets({ appId: APP_ID, environmentId: ENV_ID, launcher: "claude-code" });
    expect(secrets).toEqual({ ANTHROPIC_API_KEY: "sk-ant-real-key" });
  });

  it("resolves OPENAI_API_KEY for a codex config", async () => {
    seedEnvVar("OPENAI_API_KEY", "sk-openai-real-key");
    const secrets = await readEvalConfigSecrets({ appId: APP_ID, environmentId: ENV_ID, launcher: "codex" });
    expect(secrets).toEqual({ OPENAI_API_KEY: "sk-openai-real-key" });
  });

  it("throws EvalSecretsError naming the missing key when it isn't set", async () => {
    seedManagedDeploymentTablesState({ envVars: [] });
    seedVaultMswState({ secrets: {} });
    await expect(
      readEvalConfigSecrets({ appId: APP_ID, environmentId: ENV_ID, launcher: "claude-code" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("does not substitute another launcher's key: a claude-code config fails when only OPENAI is set", async () => {
    // Only OPENAI_API_KEY exists; a claude-code config must fail, not silently
    // return {} and run its agent unauthenticated.
    seedEnvVar("OPENAI_API_KEY", "sk-openai-real-key");
    await expect(
      readEvalConfigSecrets({ appId: APP_ID, environmentId: ENV_ID, launcher: "claude-code" }),
    ).rejects.toBeInstanceOf(EvalSecretsError);
  });

  it("rejects an unknown launcher rather than dispatching a run with no key", async () => {
    await expect(
      readEvalConfigSecrets({ appId: APP_ID, environmentId: ENV_ID, launcher: "aider" }),
    ).rejects.toBeInstanceOf(EvalSecretsError);
  });
});
