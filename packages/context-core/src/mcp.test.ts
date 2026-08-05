import { describe, expect, it } from 'vitest';
import { validateMcpConfig } from './mcp';

describe('validateMcpConfig — structural validation', () => {
  it('accepts a valid stdio server and returns the parsed config', () => {
    const result = validateMcpConfig(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { FOO: '${BAR}' } },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { FOO: '${BAR}' } },
      },
    });
  });

  it('accepts a valid remote server with type set', () => {
    const result = validateMcpConfig(
      JSON.stringify({ mcpServers: { api: { url: 'https://mcp.example.com', type: 'http', headers: { Authorization: '${TOKEN}' } } } }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns when a remote server omits type, without failing validation', () => {
    const result = validateMcpConfig(JSON.stringify({ mcpServers: { api: { url: 'https://mcp.example.com' } } }));

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      {
        path: 'mcpServers.api.type',
        code: 'type_recommended',
        message: '"type" is recommended when "url" is present — some targets error without it',
      },
    ]);
  });

  it('rejects a server defining both command and url', () => {
    const result = validateMcpConfig(JSON.stringify({ mcpServers: { bad: { command: 'npx', url: 'https://x' } } }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'mcpServers.bad',
        code: 'transport_conflict',
        message: 'server must be either stdio ("command") or remote ("url"), not both',
      },
    ]);
  });

  it('rejects a server defining neither command nor url', () => {
    const result = validateMcpConfig(JSON.stringify({ mcpServers: { bad: { env: { FOO: 'bar' } } } }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: 'mcpServers.bad', code: 'transport_missing', message: 'server must define either "command" (stdio) or "url" (remote)' },
    ]);
  });

  it('preserves unknown per-server keys as warnings, target-specific keys included', () => {
    const result = validateMcpConfig(
      JSON.stringify({ mcpServers: { api: { url: 'https://x', type: 'sse', timeout: 5000, oauth: true } } }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      { path: 'mcpServers.api.timeout', code: 'unknown_key', message: 'unknown/target-specific key "timeout" — preserved, not validated' },
      { path: 'mcpServers.api.oauth', code: 'unknown_key', message: 'unknown/target-specific key "oauth" — preserved, not validated' },
    ]);
  });

  it('rejects malformed JSON without throwing', () => {
    // A throw here would fail this test directly (uncaught exception) — the
    // concrete assertions below are what prove the "without throwing" contract.
    const result = validateMcpConfig('{ not valid json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe('invalid_json');
    expect(result.config).toBeUndefined();
  });

  it('rejects when mcpServers is missing or not an object', () => {
    expect(validateMcpConfig('{}').errors).toEqual([
      { path: 'mcpServers', code: 'invalid_type', message: 'mcpServers must be an object mapping server name to config' },
    ]);
    expect(validateMcpConfig('{"mcpServers": []}').errors).toEqual([
      { path: 'mcpServers', code: 'invalid_type', message: 'mcpServers must be an object mapping server name to config' },
    ]);
  });

  it('rejects a non-object top-level value', () => {
    expect(validateMcpConfig('null').errors).toEqual([{ path: '(root)', code: 'invalid_type', message: 'mcp.json must be a JSON object' }]);
    expect(validateMcpConfig('"not an object"').errors).toEqual([
      { path: '(root)', code: 'invalid_type', message: 'mcp.json must be a JSON object' },
    ]);
  });
});

describe('validateMcpConfig — secret lint', () => {
  it('passes ${VAR} and ${VAR:-default} references', () => {
    const result = validateMcpConfig(
      JSON.stringify({
        mcpServers: { fs: { command: 'npx', env: { TOKEN: '${GH_TOKEN}', REGION: '${AWS_REGION:-us-east-1}' } } },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('passes a plain non-secret literal env value', () => {
    const result = validateMcpConfig(JSON.stringify({ mcpServers: { fs: { command: 'npx', env: { NODE_ENV: 'production' } } } }));
    expect(result.ok).toBe(true);
  });

  it('blocks a known-prefix literal secret (sk-live-...) with code secret-literal', () => {
    const result = validateMcpConfig(
      JSON.stringify({ mcpServers: { api: { url: 'https://x', type: 'http', headers: { Authorization: 'sk-live-abcdef0123456789' } } } }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'mcpServers.api.headers.Authorization',
        code: 'secret-literal',
        message: '"Authorization" looks like a literal secret (known-secret-prefix); use ${VAR} instead',
      },
    ]);
  });

  it('blocks a GitHub PAT literal in env by prefix', () => {
    const result = validateMcpConfig(
      JSON.stringify({ mcpServers: { fs: { command: 'npx', env: { GH_TOKEN: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz' } } } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe('secret-literal');
  });

  it('blocks a long opaque hex-like token with no known prefix as high-entropy', () => {
    const result = validateMcpConfig(
      JSON.stringify({ mcpServers: { fs: { command: 'npx', env: { SESSION_ID: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' } } } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain('high-entropy');
  });

  it('blocks a KEY/TOKEN/SECRET/PASSWORD-named var carrying a short non-${} literal', () => {
    const result = validateMcpConfig(JSON.stringify({ mcpServers: { fs: { command: 'npx', env: { DB_PASSWORD: 'hunter2' } } } }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain('secret-named-key');
  });

  it('does not flag a SECRET-named var whose value is empty', () => {
    const result = validateMcpConfig(JSON.stringify({ mcpServers: { fs: { command: 'npx', env: { API_SECRET: '' } } } }));
    expect(result.ok).toBe(true);
  });

  it('collects violations across env and headers, multiple servers, in one pass', () => {
    const result = validateMcpConfig(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', env: { GH_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz012345' } },
          api: { url: 'https://x', type: 'http', headers: { Authorization: 'sk-live-abcdef0123456789' } },
        },
      }),
    );

    expect(result.errors.map((e) => e.path).sort()).toEqual([
      'mcpServers.api.headers.Authorization',
      'mcpServers.fs.env.GH_TOKEN',
    ]);
  });

  it('does not include a server with a secret-literal violation in the returned config', () => {
    const result = validateMcpConfig(
      JSON.stringify({ mcpServers: { fs: { command: 'npx', env: { GH_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz012345' } } } }),
    );
    expect(result.config).toBeUndefined();
  });
});
