/**
 * Hand-rolled JSON-RPC 2.0 dispatcher mounted at `POST /v1/mcp`.
 *
 * `@modelcontextprotocol/sdk` is used for its TYPES/SCHEMAS only — no
 * transport class from the SDK is imported, and nothing here holds a
 * session: every request is a single stateless POST, matching every other
 * `/v1/*` route. `check-gateway-core-imports.mjs` separately bans `ws`
 * outright, so a transport import couldn't land here even by accident.
 *
 * Authorization reuses the EXACT REST guards (`enforcePermission`,
 * `enforceEntitlement`, `enforceRateLimit`) by calling them as ordinary Hono
 * middleware with a no-op `next` — a guard either calls `next()` (granted,
 * the call proceeds) or returns a `Response` (denied). This is the same
 * composition `registerAuthenticatedRoute` builds for REST, just invoked
 * directly instead of installed on Hono's router — the mount bypasses that
 * registration path entirely (by design: `/v1/mcp` dispatches to one of
 * several tools per call, not one route per path), so nothing here is
 * automatic; every guard below is an explicit call.
 */

import { ErrorCode, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  InitializeResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mapClickHouseError, toErrorResponse, getErrorStatusCode } from '@repo/observability-service';
import type { Next } from 'hono';
import type { AppContext } from '../routes/_shared';
import { enforcePermission } from '../../lib/permissions';
import { enforceEntitlement } from '../../lib/entitlements';
import { enforceRateLimit } from '../../lib/rate-limit';
import { RATE_LIMITS } from '../../rate-limits';
import { MCP_TOOLS, findTool, type McpToolDefinition } from './tools';
import { GUIDE_RESOURCE_TEXT, GUIDE_RESOURCE_URI } from './resources';

const SERVER_NAME = 'outerlayer-gateway';
const SERVER_VERSION = '1.0';

/** Server-defined JSON-RPC error codes in the implementation-defined range
 * (-32000 to -32099 per the JSON-RPC 2.0 spec). The SDK's {@link ErrorCode}
 * enum covers protocol-level failures only (parse/method/params); these
 * three are OuterLayer's own application-level denials, deliberately kept
 * OUT of a REST-shaped `{ error: { code, message } }` envelope — a
 * permission-denied tool call is a JSON-RPC error, not the REST envelope. */
const APP_ERROR_CODE = {
  PermissionDenied: -32001,
  EntitlementRequired: -32002,
  RateLimited: -32003,
} as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

const NO_OP_NEXT: Next = async () => undefined;

/**
 * Run a REST-shaped Hono guard (`enforcePermission(...)`,
 * `enforceEntitlement(...)`) outside route registration, reporting the
 * denying Response's HTTP status. The guard calls `next()` (returns
 * `undefined`) on success or returns a `Response` on denial — this reads
 * that outcome without ever installing the guard on Hono's router. The
 * status matters because these guards deny two structurally different
 * ways: a real decision (403/402) the caller can act on, or an
 * infrastructure fault (5xx, e.g. the entitlement Supabase lookup throwing)
 * neither upgrading nor re-authing fixes. Only the status distinguishes
 * them, so a caller that needs to report the right JSON-RPC error must see
 * it rather than a plain pass/fail. (`enforceRateLimit` denials are read
 * off the raw Response instead — see {@link rateLimitedError}, which needs
 * the 429's headers, not just its status.)
 */
async function guardStatus(
  c: AppContext,
  guard: (c: AppContext, next: Next) => Promise<Response | void>,
): Promise<{ passed: true } | { passed: false; status: number }> {
  const outcome = await guard(c, NO_OP_NEXT);
  return outcome === undefined ? { passed: true } : { passed: false, status: outcome.status };
}

/** Exported so tools-conformance.test.ts can assert, for the REAL tool
 * registry, that no defaulted/optional field is ever advertised as
 * `required` — the class of bug that slips past a schema-shaped-like-this
 * unit test but not a loop over the live table. */
export function toolToMcpTool(tool: McpToolDefinition): Tool {
  // z.toJSONSchema defaults to 'output' mode, which reflects what the schema
  // PRODUCES after parsing — a field with `.default(...)` is always present
  // on output, so it lands in `required`. Callers send INPUT, where a
  // defaulted/optional field is legitimately absent; `io: 'input'` reports
  // the schema from that side instead.
  const schema = z.toJSONSchema(tool.zodInputSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: (schema.properties as Tool['inputSchema']['properties']) ?? {},
      required: (schema.required as string[] | undefined) ?? [],
    },
  };
}

/**
 * Per the MCP spec, `initialize` must echo the client's requested
 * `protocolVersion` when this server supports it, and fall back to its own
 * latest supported version otherwise (including when the client omits the
 * field, or sends something that isn't a string) — never blindly echo an
 * unsupported version, which would claim compatibility this server doesn't
 * have.
 */
function negotiateProtocolVersion(params: unknown): string {
  const requested =
    params && typeof params === 'object' && 'protocolVersion' in params
      ? (params as { protocolVersion: unknown }).protocolVersion
      : undefined;
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

async function handleInitialize(params: unknown): Promise<InitializeResult> {
  return {
    protocolVersion: negotiateProtocolVersion(params),
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function handleToolsList(): ListToolsResult {
  return { tools: MCP_TOOLS.map(toolToMcpTool) };
}

function handleResourcesList(): ListResourcesResult {
  return {
    resources: [
      {
        uri: GUIDE_RESOURCE_URI,
        name: 'OuterLayer data model guide',
        description: 'Session/trace/span, facet/topic, snapshot-vs-live, cost, and time semantics for the tools on this server.',
        mimeType: 'text/markdown',
      },
    ],
  };
}

function handleResourcesRead(params: unknown): ReadResourceResult {
  const parsed = z.object({ uri: z.string() }).safeParse(params);
  if (!parsed.success || parsed.data.uri !== GUIDE_RESOURCE_URI) {
    throw new McpProtocolError(ErrorCode.InvalidParams, `Unknown resource: ${JSON.stringify(params)}`);
  }
  return {
    contents: [{ uri: GUIDE_RESOURCE_URI, mimeType: 'text/markdown', text: GUIDE_RESOURCE_TEXT }],
  };
}

class McpProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class McpAppError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    /** Machine-readable detail attached as the JSON-RPC `error.data`. */
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The rate-limit denial as an {@link McpAppError}, carrying the backoff
 * detail a REST caller would read off the 429's `Retry-After` /
 * `X-RateLimit-*` headers — a JSON-RPC error body is the only channel an
 * MCP client sees, so without this the denial gives no clue when retrying
 * becomes worthwhile.
 */
function rateLimitedError(denial: Response): McpAppError {
  const retryAfter = Number(denial.headers?.get('Retry-After'));
  const limit = Number(denial.headers?.get('X-RateLimit-Limit'));
  return new McpAppError(APP_ERROR_CODE.RateLimited, 'Rate limit exceeded. Please retry later.', {
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  });
}

/**
 * Maps a denying guard's HTTP status to the JSON-RPC error this dispatcher
 * reports — a 402/403 is a real decision the guard made about the caller;
 * a 5xx is the guard's own infrastructure failing to decide at all (e.g.
 * `enforceEntitlement`'s Supabase lookup throwing). Reporting the latter as
 * `EntitlementRequired` tells the caller to upgrade their tier for a
 * problem upgrading can't fix. Any other status is unexpected for a guard
 * denial and is treated the same as a 5xx: an internal error, logged.
 */
function mapGuardDenial(status: number, deniedMessage: string): McpAppError {
  if (status === 402) return new McpAppError(APP_ERROR_CODE.EntitlementRequired, deniedMessage);
  if (status === 403) return new McpAppError(APP_ERROR_CODE.PermissionDenied, deniedMessage);
  console.error(`[mcp] guard denied the call with unexpected status ${status}`);
  return new McpAppError(ErrorCode.InternalError, 'An unexpected error occurred while checking access.');
}

async function handleToolsCall(c: AppContext, params: unknown): Promise<CallToolResult> {
  const parsed = z.object({ name: z.string(), arguments: z.unknown().optional() }).safeParse(params);
  if (!parsed.success) {
    throw new McpProtocolError(ErrorCode.InvalidParams, 'tools/call requires { name, arguments? }');
  }
  const tool = findTool(parsed.data.name);
  if (!tool) {
    throw new McpProtocolError(ErrorCode.MethodNotFound, `Unknown tool: ${parsed.data.name}`);
  }

  const input = tool.zodInputSchema.safeParse(parsed.data.arguments ?? {});
  if (!input.success) {
    throw new McpProtocolError(ErrorCode.InvalidParams, `Invalid arguments for ${tool.name}: ${input.error.message}`);
  }

  // RBAC → entitlement → rate limit → handler — same guard order
  // `registerAuthenticatedRoute` composes for REST (see openapi/index.ts).
  const permissionResult = await guardStatus(c, enforcePermission(tool.requiredPermission));
  if (!permissionResult.passed) {
    throw mapGuardDenial(permissionResult.status, `Forbidden: missing required permission '${tool.requiredPermission}'`);
  }
  if (tool.entitlement) {
    const entitlementResult = await guardStatus(c, enforceEntitlement(tool.entitlement));
    if (!entitlementResult.passed) {
      throw mapGuardDenial(entitlementResult.status, `Tenant tier does not include '${tool.entitlement}'`);
    }
  }
  if (tool.rateLimit) {
    const denial = await enforceRateLimit(tool.rateLimit)(c, NO_OP_NEXT);
    if (denial !== undefined) throw rateLimitedError(denial);
  }

  // Tool executors run the same service code as their REST twins and throw
  // the same AnalyticsErrors (validation, timeout, unavailable). Map them to
  // the identical structured envelope REST would return, delivered as an
  // isError tool result — a rejected actor filter or a ClickHouse outage is
  // a normal domain answer, not a JSON-RPC transport fault.
  let body: unknown;
  try {
    body = await tool.execute(c, input.data);
  } catch (err) {
    const mapped = mapClickHouseError(err);
    if (getErrorStatusCode(mapped) === 500) console.error('[mcp] tool execution failed', err);
    body = toErrorResponse(mapped);
  }
  const isError = typeof body === 'object' && body !== null && 'error' in body;
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Meter the store-free protocol methods (everything except `tools/call`,
 * whose per-tool limits already apply, and `ping`, the health probe clients
 * poll on their own cadence). Static responses cost no storage read, but an
 * authenticated caller in a tight loop shouldn't get an unmetered endpoint
 * out of that.
 */
async function enforceProtocolRateLimit(c: AppContext): Promise<void> {
  const denial = await enforceRateLimit(RATE_LIMITS.mcpProtocol)(c, NO_OP_NEXT);
  if (denial !== undefined) throw rateLimitedError(denial);
}

async function dispatchOne(c: AppContext, request: JsonRpcRequest) {
  try {
    switch (request.method) {
      case 'initialize':
        await enforceProtocolRateLimit(c);
        return jsonRpcResult(request.id, await handleInitialize(request.params));
      case 'ping':
        return jsonRpcResult(request.id, {});
      case 'tools/list':
        await enforceProtocolRateLimit(c);
        return jsonRpcResult(request.id, handleToolsList());
      case 'tools/call':
        return jsonRpcResult(request.id, await handleToolsCall(c, request.params));
      case 'resources/list':
        await enforceProtocolRateLimit(c);
        return jsonRpcResult(request.id, handleResourcesList());
      case 'resources/read':
        await enforceProtocolRateLimit(c);
        return jsonRpcResult(request.id, handleResourcesRead(request.params));
      default:
        return jsonRpcError(request.id, ErrorCode.MethodNotFound, `Unknown method: ${request.method}`);
    }
  } catch (err) {
    if (err instanceof McpProtocolError) return jsonRpcError(request.id, err.code, err.message);
    if (err instanceof McpAppError) return jsonRpcError(request.id, err.code, err.message, err.data);
    console.error('[mcp] tools/call handler threw', err);
    return jsonRpcError(request.id, ErrorCode.InternalError, 'An unexpected error occurred');
  }
}

/** `POST /v1/mcp` — the only method this mount accepts (see {@link mcpMethodNotAllowed}). */
export async function handleMcpRequest(c: AppContext): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, ErrorCode.ParseError, 'Request body is not valid JSON.'), 400);
  }

  if (Array.isArray(body)) {
    // JSON-RPC batch requests are spec-permitted to reject outright.
    return c.json(jsonRpcError(null, ErrorCode.InvalidRequest, 'Batch requests are not supported.'), 400);
  }

  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(jsonRpcError(null, ErrorCode.InvalidRequest, 'Malformed JSON-RPC 2.0 request.'), 400);
  }

  // A JSON-RPC Notification is a request with no `id` MEMBER at all — Zod's
  // `.optional()` leaves `id` as `undefined` in exactly that case, and only
  // that case (a request that explicitly sends `id: null` parses to `null`,
  // a normal — if discouraged — request id, not a notification). The spec
  // forbids any JSON-RPC response to a Notification, including an error for
  // an unrecognized method; the Streamable HTTP transport instead requires a
  // bare 202 with no body.
  if (parsed.data.id === undefined) {
    return c.body(null, 202);
  }

  const response = await dispatchOne(c, parsed.data);
  return c.json(response, 200);
}

/** `GET` / `DELETE` `/v1/mcp` — this mount is POST-only (stateless: no
 * session to establish with GET or tear down with DELETE). Plain HTTP 405,
 * not a JSON-RPC error — there is no JSON-RPC request to respond to. */
export function mcpMethodNotAllowed(c: AppContext): Response {
  return c.json(
    { error: { code: 'method_not_allowed', message: `POST ${new URL(c.req.url).pathname} is the only supported method.` } },
    { status: 405, headers: { Allow: 'POST' } } as unknown as 405,
  );
}
