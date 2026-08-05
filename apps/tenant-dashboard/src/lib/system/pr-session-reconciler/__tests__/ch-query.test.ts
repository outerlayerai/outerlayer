/**
 * ClickHouse query adapters: a null client (ClickHouse unconfigured) yields
 * null — the callers' skip signal — and a live client is wrapped into the
 * one-shot JSONEachRow query fn with the exact request shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  createTenantReadClient: vi.fn(),
  getDefaultClient: vi.fn(),
}));

vi.mock("@/lib/analytics/client", () => ({
  createTenantReadClient: m.createTenantReadClient,
  getDefaultClient: m.getDefaultClient,
}));

import { tenantChQuery, sweepChQuery } from "../ch-query";

const ROWS = [{ TraceId: "t1" }];

function fakeClient() {
  return { query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue(ROWS) }) };
}

beforeEach(() => vi.clearAllMocks());

describe("ch-query adapters", () => {
  it("tenantChQuery: null client → null; live client → JSONEachRow query with exact params", async () => {
    m.createTenantReadClient.mockReturnValue(null);
    expect(tenantChQuery({ tenantId: "t-1", appId: "a-1" })).toBeNull();

    const client = fakeClient();
    m.createTenantReadClient.mockReturnValue(client);
    const fn = tenantChQuery({ tenantId: "t-1", appId: "a-1" })!;
    expect(m.createTenantReadClient).toHaveBeenLastCalledWith({ tenantId: "t-1", appId: "a-1" });
    const rows = await fn("SELECT 1", { x: 1 });
    expect(client.query).toHaveBeenCalledWith({
      query: "SELECT 1",
      query_params: { x: 1 },
      format: "JSONEachRow",
    });
    expect(rows).toEqual(ROWS);
  });

  it("sweepChQuery: null default client → null; live client → wrapped query fn", async () => {
    m.getDefaultClient.mockReturnValue(null);
    expect(sweepChQuery()).toBeNull();

    const client = fakeClient();
    m.getDefaultClient.mockReturnValue(client);
    const rows = await sweepChQuery()!("SELECT 2", {});
    expect(client.query).toHaveBeenCalledWith({
      query: "SELECT 2",
      query_params: {},
      format: "JSONEachRow",
    });
    expect(rows).toEqual(ROWS);
  });
});
