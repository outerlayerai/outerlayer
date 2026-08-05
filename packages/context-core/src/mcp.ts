/**
 * `mcp.json` validation. Takes the raw JSON
 * text (JSON parse failure is a `ValidationResult` error, never a throw).
 * Structural validation (stdio/remote XOR, unknown-key preservation as
 * warnings) and the secret lint (`env`/`headers` literal-secret detection)
 * are folded into one `errors`/`warnings` stream — secret-lint violations use
 * code `'secret-literal'` and land in `errors` (the save layer blocks on
 * them).
 */
import { z } from 'zod';
import type { FieldIssue, ValidationResult } from '@outerlayer/context-format';

const CANONICAL_SERVER_KEYS = new Set(['command', 'args', 'env', 'url', 'headers', 'type']);

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: 'stdio' | 'http' | 'sse';
  [key: string]: unknown;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const stdioServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    type: z.enum(['stdio', 'http', 'sse']).optional(),
  })
  .passthrough();

const remoteServerSchema = z
  .object({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    type: z.enum(['stdio', 'http', 'sse']).optional(),
  })
  .passthrough();

const VAR_REF_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/;

const KNOWN_SECRET_PREFIXES = [
  'sk-',
  'sk_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'whsec_',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxr-',
  'AKIA',
  'Bearer ',
];

/** KEY/TOKEN/SECRET/PASSWORD-named vars carrying a non-`${}` value are suspect regardless of entropy. */
const SECRET_NAME_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Opaque base64/hex-alphabet token of meaningful length, mixing letters and digits. */
function looksHighEntropy(value: string): boolean {
  if (value.length < 20) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function lintSecretValue(key: string, value: string): string | null {
  if (VAR_REF_PATTERN.test(value.trim())) return null;
  if (KNOWN_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'known-secret-prefix';
  if (looksHighEntropy(value)) return 'high-entropy';
  if (SECRET_NAME_PATTERN.test(key) && value.length > 0) return 'secret-named-key';
  return null;
}

/** Validates raw `mcp.json` text. Never throws — JSON parse failure is a structural error. */
export function validateMcpConfig(json: string): ValidationResult & { config?: McpConfig } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '(root)', code: 'invalid_json', message: err instanceof Error ? err.message : 'invalid JSON' }],
      warnings: [],
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ path: '(root)', code: 'invalid_type', message: 'mcp.json must be a JSON object' }],
      warnings: [],
    };
  }

  const mcpServers = (raw as Record<string, unknown>).mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null || Array.isArray(mcpServers)) {
    return {
      ok: false,
      errors: [
        { path: 'mcpServers', code: 'invalid_type', message: 'mcpServers must be an object mapping server name to config' },
      ],
      warnings: [],
    };
  }

  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  const configServers: Record<string, McpServerConfig> = {};

  for (const [name, serverRaw] of Object.entries(mcpServers as Record<string, unknown>)) {
    validateServer(name, serverRaw, errors, warnings, configServers);
  }

  const ok = errors.length === 0;
  return ok ? { ok, errors, warnings, config: { mcpServers: configServers } } : { ok, errors, warnings };
}

function validateServer(
  name: string,
  raw: unknown,
  errors: FieldIssue[],
  warnings: FieldIssue[],
  configServers: Record<string, McpServerConfig>,
): void {
  const base = `mcpServers.${name}`;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ path: base, code: 'invalid_type', message: 'server config must be an object' });
    return;
  }

  const obj = raw as Record<string, unknown>;
  const hasCommand = 'command' in obj;
  const hasUrl = 'url' in obj;

  if (hasCommand && hasUrl) {
    errors.push({
      path: base,
      code: 'transport_conflict',
      message: 'server must be either stdio ("command") or remote ("url"), not both',
    });
    return;
  }
  if (!hasCommand && !hasUrl) {
    errors.push({
      path: base,
      code: 'transport_missing',
      message: 'server must define either "command" (stdio) or "url" (remote)',
    });
    return;
  }

  const transport: 'stdio' | 'remote' = hasCommand ? 'stdio' : 'remote';
  const schema = transport === 'stdio' ? stdioServerSchema : remoteServerSchema;
  const result = schema.safeParse(obj);

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.length > 0 ? `${base}.${issue.path.join('.')}` : base,
        code: issue.code,
        message: issue.message,
      });
    }
  }

  if (transport === 'remote' && result.success && obj.type === undefined) {
    warnings.push({
      path: `${base}.type`,
      code: 'type_recommended',
      message: '"type" is recommended when "url" is present — some targets error without it',
    });
  }

  for (const key of Object.keys(obj)) {
    if (!CANONICAL_SERVER_KEYS.has(key)) {
      warnings.push({
        path: `${base}.${key}`,
        code: 'unknown_key',
        message: `unknown/target-specific key "${key}" — preserved, not validated`,
      });
    }
  }

  for (const field of ['env', 'headers'] as const) {
    const map = obj[field];
    if (typeof map !== 'object' || map === null) continue;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const reason = lintSecretValue(key, value);
      if (reason) {
        errors.push({
          path: `${base}.${field}.${key}`,
          code: 'secret-literal',
          message: `"${key}" looks like a literal secret (${reason}); use \${VAR} instead`,
        });
      }
    }
  }

  if (result.success) {
    configServers[name] = obj as McpServerConfig;
  }
}
