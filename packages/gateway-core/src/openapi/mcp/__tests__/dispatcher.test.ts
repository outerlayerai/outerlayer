/**
 * Protocol-level tests for `POST /v1/mcp` — the JSON-RPC 2.0 envelope, method
 * dispatch, and per-tool guard composition. Tool CONTENT (which tools,
 * whether their schemas match REST) is covered by `tools-conformance.test.ts`
 * and `list-topics-parity.test.ts`; this suite fakes the tool table so it can
 * pin dispatcher behavior without wiring a real ClickHouse/Supabase call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError, ServiceUnavailableError } from '@repo/observability-service';
import type { AppContext } from '../../routes/_shared';

vi.mock('../tools', async () => {
  const { z } = await import('zod');
  const fakeTool = {
    name: 'fake_tool',
    description: 'A fake tool for dispatcher-level tests.',
    zodInputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
    zodOutputSchema: z.object({ ok: z.boolean() }),
    requiredPermission: 'metrics.read' as const,
    entitlement: 'topics_enabled' as const,
    rateLimit: { free: { namespace: 'fake', limit: 10, durationMs: 60_000, cost: 1 }, paid: { namespace: 'fake', limit: 100, durationMs: 60_000, cost: 1 } },
    execute: vi.fn(async () => ({ data: { ok: true } })),
  };
  return {
    MCP_TOOLS: [fakeTool],
    findTool: (name: string) => (name === fakeTool.name ? fakeTool : undefined),
  };
});

const enforcePermission = vi.fn();
vi.mock('../../../lib/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/permissions')>();
  return { ...actual, enforcePermission: (...args: unknown[]) => enforcePermission(...args) };
});

const enforceEntitlement = vi.fn();
vi.mock('../../../lib/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/entitlements')>();
  return { ...actual, enforceEntitlement: (...args: unknown[]) => enforceEntitlement(...args) };
});

const enforceRateLimit = vi.fn();
vi.mock('../../../lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/rate-limit')>();
  return { ...actual, enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args) };
});

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { handleMcpRequest, mcpMethodNotAllowed } from '../dispatcher';
import { MCP_TOOLS } from '../tools';

const FAKE_TOOL = MCP_TOOLS[0] as unknown as { name: string; description: string; execute: ReturnType<typeof vi.fn> };

/** A guard factory that always grants (calls `next()`). */
const ALWAYS_GRANT = () => async () => undefined;
/** A guard factory that always denies with a Response, mirroring the real
 * guards' `c.json({...}, 4xx)` denial shape. */
const denyWith = (body: unknown, status: number) => () => async (c: AppContext) => c.json(body, status as never);

function buildContext(body: unknown): AppContext {
  return {
    req: { method: 'POST', path: '/v1/mcp', json: vi.fn(async () => body) },
    env: {},
    get: vi.fn((key: string) => (key === 'user' ? { tenantId: 'tenant-1', appId: 'app-1', permissions: [] } : undefined)),
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
    body: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as AppContext;
}

describe('handleMcpRequest — JSON-RPC envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforcePermission.mockImplementation(ALWAYS_GRANT);
    enforceEntitlement.mockImplementation(ALWAYS_GRANT);
    enforceRateLimit.mockImplementation(ALWAYS_GRANT);
  });

  it('rejects a malformed (non-JSON) body with a JSON-RPC ParseError at 400', async () => {
    const c = {
      req: { method: 'POST', path: '/v1/mcp', json: vi.fn(async () => { throw new SyntaxError('bad json'); }) },
      env: {},
      get: vi.fn(),
      json: vi.fn((body: unknown, status?: number) => ({ body, status })),
    } as unknown as AppContext;

    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } }; status: number };

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(-32700);
  });

  it('rejects a JSON-RPC batch (array) request', async () => {
    const c = buildContext([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number; message: string } }; status: number };

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(-32600);
    expect(result.body.error.message).toMatch(/batch/i);
  });

  it('rejects a request missing jsonrpc: "2.0"', async () => {
    const c = buildContext({ id: 1, method: 'tools/list' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } }; status: number };

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(-32600);
  });

  it('answers initialize with the protocol version and tool/resource capabilities', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = (await handleMcpRequest(c)) as unknown as {
      body: { jsonrpc: '2.0'; id: number; result: { protocolVersion: string; capabilities: { tools: object; resources: object } } };
    };

    expect(result.body.jsonrpc).toBe('2.0');
    expect(result.body.id).toBe(1);
    expect(result.body.result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(typeof result.body.result.protocolVersion).toBe('string');
  });

  it('answers initialize with the exact server name and version', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = (await handleMcpRequest(c)) as unknown as {
      body: { result: { serverInfo: { name: string; version: string } } };
    };

    expect(result.body.result.serverInfo).toEqual({ name: 'outerlayer-gateway', version: '1.0' });
  });

  it('answers an explicit id: null request with id: null on an error response, not a Notification', async () => {
    // A request with an "id" MEMBER present, even if its value is null, is a
    // normal (if discouraged) Request under JSON-RPC 2.0 — distinct from a
    // Notification, which has no "id" member at all. It still gets a
    // response.
    const c = buildContext({ jsonrpc: '2.0', id: null, method: 'not/a/method' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { id: null; error: { code: number } } };
    expect(result.body.id).toBeNull();
    expect(result.body.error.code).toBe(-32601);
  });

  it('returns MethodNotFound for an unrecognized JSON-RPC method', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 7, method: 'not/a/method' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };

    expect(result.body.error.code).toBe(-32601);
  });

  it('answers ping with an empty result, echoing the request id', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 42, method: 'ping' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { id: number; result: object } };

    expect(result.body.id).toBe(42);
    expect(result.body.result).toEqual({});
  });

  it('replies to a Notification (no id member) with a bare 202 and no JSON-RPC body, even for a known method', async () => {
    const c = buildContext({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = (await handleMcpRequest(c)) as unknown as { body: unknown; status: number };

    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
  });

  it('replies to a Notification with 202 even for an UNRECOGNIZED method — the spec forbids any reply, including an error', async () => {
    const c = buildContext({ jsonrpc: '2.0', method: 'not/a/method' });
    const result = (await handleMcpRequest(c)) as unknown as { body: unknown; status: number };

    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
  });

  it('lists the fake tool with a JSON-schema inputSchema derived from its Zod schema', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { tools: Array<{ name: string; inputSchema: { type: string; properties: object; required: string[] } }> } } };

    expect(result.body.result.tools).toEqual([
      {
        name: 'fake_tool',
        description: FAKE_TOOL.description,
        // `limit` carries a Zod .default(5), so on the INPUT side of the
        // schema (what a caller may legitimately omit) it is not required —
        // z.toJSONSchema's default 'output' mode would put it in `required`
        // instead, describing what's always present after parsing, not what
        // a caller must send.
        inputSchema: { type: 'object', properties: expect.objectContaining({ limit: expect.any(Object) }), required: [] },
      },
    ]);
  });

  it('advertises the guide resource on resources/list and serves it on resources/read', async () => {
    const listResult = (await handleMcpRequest(buildContext({ jsonrpc: '2.0', id: 3, method: 'resources/list' }))) as unknown as {
      body: { result: { resources: Array<{ uri: string; mimeType: string }> } };
    };
    expect(listResult.body.result.resources).toEqual([
      expect.objectContaining({ uri: 'outerlayer://guide', mimeType: 'text/markdown' }),
    ]);

    const readResult = (await handleMcpRequest(
      buildContext({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'outerlayer://guide' } }),
    )) as unknown as { body: { result: { contents: Array<{ uri: string; text: string }> } } };
    expect(readResult.body.result.contents[0].uri).toBe('outerlayer://guide');
    expect(readResult.body.result.contents[0].text.length).toBeGreaterThan(0);
  });

  it('rejects resources/read for an unknown uri with InvalidParams', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'outerlayer://nope' } });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };
    expect(result.body.error.code).toBe(-32602);
  });

  it('calls the tool and returns its body as structuredContent on tools/call', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fake_tool', arguments: { limit: 3 } } });
    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { structuredContent: unknown; content: Array<{ type: string; text: string }> } } };

    expect(FAKE_TOOL.execute).toHaveBeenCalledWith(c, { limit: 3 });
    expect(result.body.result.structuredContent).toEqual({ data: { ok: true } });
    expect(result.body.result.content).toEqual([{ type: 'text', text: JSON.stringify({ data: { ok: true } }) }]);
  });

  it('returns MethodNotFound for an unknown tool name', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };
    expect(result.body.error.code).toBe(-32601);
  });

  it('returns InvalidParams when a tool call fails its input schema', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fake_tool', arguments: { limit: 999 } } });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };
    expect(result.body.error.code).toBe(-32602);
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });

  it('returns InvalidParams when params is not shaped like { name, arguments? } at all', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { arguments: {} } });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };
    expect(result.body.error.code).toBe(-32602);
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });

  it('an entitlement-denied tool call is a JSON-RPC error, not a REST envelope', async () => {
    enforceEntitlement.mockImplementation(denyWith({ error: { code: 'entitlement_required', message: 'nope' } }, 402));
    const c = buildContext({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } }; status: number };

    expect(result.status).toBe(200);
    expect(result.body.error.code).toBe(-32002);
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });

  it('flags the tool result as an error when the tool body carries an "error" key', async () => {
    FAKE_TOOL.execute.mockResolvedValueOnce({ error: 'something went wrong' });
    const c = buildContext({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { isError?: true } } };

    expect(result.body.result.isError).toBe(true);
  });

  it('does not flag the tool result as an error when the body has no "error" key', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { isError?: true } } };

    expect(result.body.result).not.toHaveProperty('isError');
  });

  it('does not flag a non-object tool body as an error, even one that happens to contain the substring "error"', async () => {
    FAKE_TOOL.execute.mockResolvedValueOnce('a message about an error');
    const c = buildContext({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { isError?: true } } };

    expect(result.body.result).not.toHaveProperty('isError');
  });

  it('a null tool body is not flagged as an error (typeof null === "object" but null !== null is false)', async () => {
    FAKE_TOOL.execute.mockResolvedValueOnce(null);
    const c = buildContext({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { isError?: true } } };

    expect(result.body.result).not.toHaveProperty('isError');
  });

  it('an unexpected throw outside the executor (a guard crashing) surfaces as a generic InternalError', async () => {
    // Executor throws map to structured isError results (tested above);
    // dispatchOne's own catch still owns crashes in the guard chain.
    enforcePermission.mockImplementation(() => {
      throw new Error('boom, unrelated to guards or schema');
    });
    const c = buildContext({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number; message: string } } };

    expect(result.body.error.code).toBe(ErrorCode.InternalError);
    expect(result.body.error.message).toBe('An unexpected error occurred');
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('a permission-denied tool call is a JSON-RPC error, not a REST envelope', async () => {
    enforcePermission.mockImplementation(denyWith({ error: { code: 'forbidden', message: 'nope' } }, 403));
    const c = buildContext({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { jsonrpc: '2.0'; id: number; error: { code: number; message: string } }; status: number };

    expect(result.status).toBe(200);
    expect(result.body.error.code).toBe(-32001);
    expect(result.body).not.toHaveProperty('result');
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });

  it('runs the guards in permission → entitlement → rate-limit order', async () => {
    const order: string[] = [];
    enforcePermission.mockImplementation(() => async () => {
      order.push('permission');
    });
    enforceEntitlement.mockImplementation(() => async () => {
      order.push('entitlement');
    });
    enforceRateLimit.mockImplementation(() => async () => {
      order.push('rateLimit');
    });
    const c = buildContext({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    await handleMcpRequest(c);

    expect(order).toEqual(['permission', 'entitlement', 'rateLimit']);
  });

  it('a rate-limited tool call is a JSON-RPC error', async () => {
    enforceRateLimit.mockImplementation(denyWith({ error: { code: 'rate_limited', message: 'slow down' } }, 429));
    const c = buildContext({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };
    expect(result.body.error.code).toBe(-32003);
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });

  // A domain error thrown by the shared service code must surface as the
  // SAME structured envelope its REST twin returns — as an isError tool
  // result — never as an opaque JSON-RPC InternalError.
  it.each([
    [new ValidationError('actorId filter requires agents.sessions.team.read'), 'validation_error'],
    [new ServiceUnavailableError('ClickHouse host not configured'), 'service_unavailable'],
  ] as const)('maps a thrown %s to a structured isError tool result', async (thrown, code) => {
    FAKE_TOOL.execute.mockRejectedValueOnce(thrown);
    const c = buildContext({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fake_tool', arguments: { limit: 3 } } });

    const result = (await handleMcpRequest(c)) as unknown as {
      body: { result: { isError?: boolean; structuredContent: { error: { code: string; message: string } } } };
    };

    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.structuredContent).toEqual({
      error: { code, message: thrown.message },
    });
  });

  it('maps an unrecognized executor crash to the generic internal_error envelope without leaking the message', async () => {
    FAKE_TOOL.execute.mockRejectedValueOnce(new Error('pool exhausted at 10.0.0.7'));
    const c = buildContext({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fake_tool', arguments: { limit: 3 } } });

    const result = (await handleMcpRequest(c)) as unknown as {
      body: { result: { isError?: boolean; structuredContent: { error: { code: string; message: string } } } };
    };

    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.structuredContent.error.code).toBe('internal_error');
    expect(result.body.result.structuredContent.error.message).not.toContain('10.0.0.7');
  });
});

describe('mcpMethodNotAllowed', () => {
  it('returns a plain 405 with an Allow: POST header and the exact error body, naming the mount that was hit', () => {
    const c = {
      req: { url: 'https://gw.example.com/v1/apps/app-1/mcp' },
      json: vi.fn((body: unknown, init?: unknown) => ({ body, init })),
    } as unknown as AppContext;
    const result = mcpMethodNotAllowed(c) as unknown as {
      body: { error: { code: string; message: string } };
      init: { status: number; headers: { Allow: string } };
    };
    expect(result.init.status).toBe(405);
    expect(result.init.headers.Allow).toBe('POST');
    expect(result.body).toEqual({
      error: { code: 'method_not_allowed', message: 'POST /v1/apps/app-1/mcp is the only supported method.' },
    });
  });
});
