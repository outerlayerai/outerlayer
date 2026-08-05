/**
 * The request dispatcher's decision tree, shared by both entrypoints.
 * Behavior pinned:
 *   - a non-"no-route" OpenAPI response is returned as-is (incl. a real 404);
 *   - only the notFound sentinel falls through to the canonical 404;
 *   - an unmatched path returns the canonical route_not_found 404 envelope.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegacyRouteContext } from "./types";

// Hoisted so the vi.mock factories (themselves hoisted) can close over them.
const h = vi.hoisted(() => ({
  NO_ROUTE_HEADER: "x-openapi-no-route",
  openApiFetch: vi.fn(),
}));

vi.mock("./openapi", () => ({
  openApiApp: { fetch: (...args: unknown[]) => h.openApiFetch(...args) },
  OPENAPI_NO_ROUTE_HEADER: h.NO_ROUTE_HEADER,
}));

import { dispatchRequest } from "./dispatch-request";

const { openApiFetch } = h;

/** An OpenAPI "no route for this path" response — the sentinel that falls through. */
const noRoute = () =>
  new Response(null, { status: 404, headers: { [h.NO_ROUTE_HEADER]: "1" } });

function makeCtx(url: string, method = "GET"): LegacyRouteContext {
  const request = new Request(url, { method }) as unknown as LegacyRouteContext["request"];
  return { request, env: {}, ctx: {}, cache: {}, gtx: {} } as unknown as LegacyRouteContext;
}

afterEach(() => vi.clearAllMocks());

describe("dispatchRequest", () => {
  it("returns a matched OpenAPI response as-is (never falls through)", async () => {
    openApiFetch.mockResolvedValue(new Response("openapi-ok", { status: 200 }));

    const res = await dispatchRequest(makeCtx("https://gw/v1/traces", "POST"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("openapi-ok");
  });

  it("returns a REAL OpenAPI 404 (no sentinel header) as-is, not a fallthrough 404", async () => {
    openApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "trace_not_found" } }), { status: 404 }),
    );

    const res = await dispatchRequest(makeCtx("https://gw/v1/traces/missing"));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("trace_not_found");
  });

  it("returns the canonical route_not_found 404 for an unmatched path", async () => {
    openApiFetch.mockResolvedValue(noRoute());

    const res = await dispatchRequest(makeCtx("https://gw/nope/nowhere"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "route_not_found", message: "Route not found" } });
  });
});
