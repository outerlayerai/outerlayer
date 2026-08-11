/**
 * Protocol-level tests for `POST /v1/mcp` — the JSON-RPC 2.0 envelope, method
 * dispatch, and per-tool guard composition. Tool CONTENT (which five tools,
 * whether their schemas match REST) is covered by `tools-conformance.test.ts`
 * and `list-topics-parity.test.ts`; this suite fakes the tool table so it can
 * pin dispatcher behavior without wiring a real ClickHouse/Supabase call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../../routes/_shared';

vi.mock('../tools', async () => {
  const { z } = await import('zod');
  const fakeTool = {
    name: 'fake_tool',
    description: 'A fake tool for dispatcher-level tests.',
    zodInputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
    zodOutputSchema: z.object({ ok: z.boolean() }),
    requiredPermission: 'metrics.read' as const,
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

  it('returns MethodNotFound for an unrecognized JSON-RPC method', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 7, method: 'not/a/method' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };

    expect(result.body.error.code).toBe(-32601);
  });

  it('lists the fake tool with a JSON-schema inputSchema derived from its Zod schema', async () => {
    const c = buildContext({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = (await handleMcpRequest(c)) as unknown as { body: { result: { tools: Array<{ name: string; inputSchema: { type: string; properties: object } }> } } };

    expect(result.body.result.tools).toEqual([
      {
        name: 'fake_tool',
        description: FAKE_TOOL.description,
        inputSchema: { type: 'object', properties: expect.objectContaining({ limit: expect.any(Object) }), required: ['limit'] },
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

  it('a permission-denied tool call is a JSON-RPC error, not a REST envelope', async () => {
    enforcePermission.mockImplementation(denyWith({ error: { code: 'forbidden', message: 'nope' } }, 403));
    const c = buildContext({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { jsonrpc: '2.0'; id: number; error: { code: number; message: string } }; status: number };

    expect(result.status).toBe(200);
    expect(result.body.error.code).toBe(-32001);
    expect(result.body).not.toHaveProperty('result');
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });

  it('a rate-limited tool call is a JSON-RPC error', async () => {
    enforceRateLimit.mockImplementation(denyWith({ error: { code: 'rate_limited', message: 'slow down' } }, 429));
    const c = buildContext({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'fake_tool', arguments: {} } });

    const result = (await handleMcpRequest(c)) as unknown as { body: { error: { code: number } } };
    expect(result.body.error.code).toBe(-32003);
    expect(FAKE_TOOL.execute).not.toHaveBeenCalled();
  });
});

describe('mcpMethodNotAllowed', () => {
  it('returns a plain 405 with an Allow: POST header', () => {
    const c = { json: vi.fn((body: unknown, init?: unknown) => ({ body, init })) } as unknown as AppContext;
    const result = mcpMethodNotAllowed(c) as unknown as { init: { status: number; headers: { Allow: string } } };
    expect(result.init.status).toBe(405);
    expect(result.init.headers.Allow).toBe('POST');
  });
});
