import "server-only";

import { collectEnvVars } from "@/lib/system/collect-env-vars";

/**
 * The eval run's model-key resolution, bridged to the env-var (Vault) store.
 * The dispatcher may hold `eval_run.insert` without RLS visibility into
 * `env_var`, so the lookup runs on the service-role client `collectEnvVars`
 * already carries. This is the single sanctioned crossing to that store —
 * named and counted here rather than constructed inline in the action body.
 */

/** Which env var(s) each launcher authenticates with. A run refuses to dispatch
 *  a config whose key is unset — add a launcher here to support it. */
const LAUNCHER_SECRET_KEYS: Record<string, readonly string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
};

export class EvalSecretsError extends Error {
  constructor(
    readonly launcher: string,
    readonly missing: string[],
  ) {
    super(
      missing.length > 0
        ? `Config launcher "${launcher}" needs ${missing.join(", ")} — set it in this environment's variables before running an eval.`
        : `Unknown eval launcher "${launcher}" — no secret mapping.`,
    );
    this.name = "EvalSecretsError";
  }
}

interface ReadEvalConfigSecretsInput {
  appId: string;
  environmentId: string;
  launcher: string;
}

/**
 * Resolve the secret env map to inject for a config's agent launcher (e.g.
 * `{ ANTHROPIC_API_KEY: "sk-ant-…" }`) from the app/environment's Vault-backed
 * env vars. The eval run injects these per-exec into the AGENT sandbox only —
 * never the grade sandbox, never logged. Throws {@link EvalSecretsError} for an
 * unknown launcher or a missing key (silently omitting it would run the agent
 * unauthenticated and fail every trial as an opaque agent_error).
 */
export async function readEvalConfigSecrets({
  appId,
  environmentId,
  launcher,
}: ReadEvalConfigSecretsInput): Promise<Record<string, string>> {
  const required = LAUNCHER_SECRET_KEYS[launcher];
  if (!required) throw new EvalSecretsError(launcher, []);

  const all = await collectEnvVars(appId, environmentId);

  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of required) {
    const value = all[key];
    if (value) secrets[key] = value;
    else missing.push(key);
  }
  if (missing.length > 0) throw new EvalSecretsError(launcher, missing);
  return secrets;
}
