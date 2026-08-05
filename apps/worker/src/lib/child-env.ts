/**
 * Environment handling for the agent child process.
 *
 * The agent runs arbitrary tenant-directed commands (clone, install, build),
 * so — exactly like the builder's child-env — it must NOT inherit the
 * runner's privileged environment (WORKER_TOKEN, worker_secret, the git clone
 * token). But unlike a build, a coding agent legitimately needs a broad,
 * mostly-unrestricted environment (its own model credential, the tenant's env
 * vars, PATH, HOME, language toolchain vars). So this is a DENY-list scrub of
 * the known-privileged keys layered over the tenant's env, not the builder's
 * strict allow-list.
 */

/**
 * Runner-internal keys that must never reach the agent process. Mirrors the
 * boot + reporting secrets threaded through the runner.
 */
const RUNNER_PRIVILEGED_KEYS = [
  'WORKER_TOKEN',
  'WORKER_RUN_ID',
  'WORKER_SECRET',
  'DASHBOARD_URL',
  'WORKER_PARAMS',
  'WORKER_PARAMS_FILE',
] as const;

/**
 * OuterLayer platform keys scrubbed from the agent env — the same list the
 * generated deployment server scrubs. The agent has no business reading the
 * platform dispatch credentials.
 */
const OUTERLAYER_RESERVED_ENV_KEYS = [
  'OUTERLAYER_API_KEY',
  'OUTERLAYER_APP_ID',
  'OUTERLAYER_BASE_URL',
  'OUTERLAYER_DISPATCH_SECRET',
] as const;

const SCRUBBED_KEYS = new Set<string>([
  ...RUNNER_PRIVILEGED_KEYS,
  ...OUTERLAYER_RESERVED_ENV_KEYS,
]);

/**
 * Build the agent's environment: the runner's own env minus the privileged
 * keys, with the tenant's env vars (which carry the agent credential, e.g.
 * ANTHROPIC_API_KEY) layered on top. A tenant var may not override a scrubbed
 * key back into existence.
 */
export function buildAgentEnv(
  tenantEnvVars: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SCRUBBED_KEYS.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(tenantEnvVars)) {
    if (!SCRUBBED_KEYS.has(key)) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

/**
 * Minimal scrubbed env for git operations the RUNNER performs directly (clone,
 * push, diff). `token`, when given, is read by the credential helper the runner
 * passes on the command line — it exists only in this child's environment, so it
 * never reaches argv, `.git/config`, or an OS keychain.
 */
export function gitChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  token?: string,
): NodeJS.ProcessEnv {
  const SAFE = [
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO',
  ];
  const env: Record<string, string> = {};
  for (const key of SAFE) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    ...(token ? { GIT_REPO_TOKEN: token } : {}),
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
  } as NodeJS.ProcessEnv;
}

export { SCRUBBED_KEYS as _SCRUBBED_KEYS_FOR_TEST };
