/**
 * AiCostService — the read + upsert, exercised through the real PostgREST
 * query path against the MSW `ai_cost_config` table (no query-chain mocks).
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedAiCostConfigMswState } from "@/test-helpers/msw-handlers";

import { aiCostService } from "./service";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR = { userId: "user-1", role: "owner" };

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: TENANT_ID, actor: ACTOR };
}

describe("AiCostService.getConfig", () => {
  it("returns the exact mapped shape for the request tenant's row", async () => {
    seedAiCostConfigMswState({
      rows: [{ tenant_id: TENANT_ID, seat_count: 12, cost_per_seat_usd: 30 }],
    });

    const config = await aiCostService.getConfig(ctx());
    expect(config).toEqual({ seatCount: 12, costPerSeatUsd: 30 });
  });

  // proves AC-070-06
  it("returns null when the tenant never configured costs", async () => {
    seedAiCostConfigMswState({ rows: [] });

    const config = await aiCostService.getConfig(ctx());
    expect(config).toBeNull();
  });

  // proves AC-070-09
  it("scopes strictly to ctx.tenantId — a row seeded under a different tenant id never leaks through", async () => {
    // Catches a D-8 regression (querying `.eq('id', ...)` against the
    // renamed `tenant_id` column, or dropping the `.eq` filter entirely):
    // either mistake would return the other tenant's row here.
    seedAiCostConfigMswState({
      rows: [{ tenant_id: OTHER_TENANT_ID, seat_count: 99, cost_per_seat_usd: 500 }],
    });

    const config = await aiCostService.getConfig(ctx());
    expect(config).toBeNull();
  });

  // proves AC-070-10
  it("coerces NUMERIC-as-string values from PostgREST", async () => {
    seedAiCostConfigMswState({
      rows: [{ tenant_id: TENANT_ID, seat_count: 20, cost_per_seat_usd: "99.50" as unknown as number }],
    });

    const config = await aiCostService.getConfig(ctx());
    expect(config).toEqual({ seatCount: 20, costPerSeatUsd: 99.5 });
  });
});

describe("AiCostService.upsertConfig", () => {
  // proves AC-070-07
  it("upserts onto tenant_id, clamping negatives and rounding fractional seats, and returns the re-read row", async () => {
    seedAiCostConfigMswState({ rows: [] });

    const written = await aiCostService.upsertConfig(ctx(), { seatCount: 12.6, costPerSeatUsd: -5 });
    expect(written).toEqual({ seatCount: 13, costPerSeatUsd: 0 });

    const reread = await aiCostService.getConfig(ctx());
    expect(reread).toEqual({ seatCount: 13, costPerSeatUsd: 0 });
  });

  it("merges onto an existing row rather than creating a second one", async () => {
    seedAiCostConfigMswState({
      rows: [{ tenant_id: TENANT_ID, seat_count: 5, cost_per_seat_usd: 10 }],
    });

    await aiCostService.upsertConfig(ctx(), { seatCount: 8, costPerSeatUsd: 15 });

    const reread = await aiCostService.getConfig(ctx());
    expect(reread).toEqual({ seatCount: 8, costPerSeatUsd: 15 });
  });

  it("throws when the write is denied at the DB (zero rows matched) — the caller must not read this as success", async () => {
    // Models a role holding `ai_cost_config.update` but not `.insert`: the
    // first-ever configure has no existing row for the UPDATE half of the
    // upsert to match, so the INSERT half is what actually runs — and it is
    // the half this role lacks. Proves D-9 / AC-7: a fire-and-forget upsert
    // with no `.select().single()` re-read would swallow this as success.
    seedAiCostConfigMswState({ rows: [], forceInsertDenied: true });

    await expect(
      aiCostService.upsertConfig(ctx(), { seatCount: 5, costPerSeatUsd: 20 }),
    ).rejects.toThrow(/ai_cost_config write failed/);

    const stillUnconfigured = await aiCostService.getConfig(ctx());
    expect(stillUnconfigured).toBeNull();
  });

  it("throws on a write that matches zero rows even with no explicit database error — proves the .select().single() re-read is what detects it", async () => {
    // Without `.select().single()`, PostgREST answers a zero-row upsert with
    // a bare 2xx and nothing written — a fire-and-forget upsert would read
    // that as success. The re-read is what turns it into a real error.
    seedAiCostConfigMswState({ rows: [], forceSilentZeroRowMatch: true });

    await expect(
      aiCostService.upsertConfig(ctx(), { seatCount: 5, costPerSeatUsd: 20 }),
    ).rejects.toThrow(/ai_cost_config write failed/);
  });

  it("does not throw once a row already exists — the same role can update after someone else's first configure", async () => {
    // The INSERT-vs-UPDATE distinction: forceInsertDenied only blocks the
    // path with no existing row. Once configured, the same role's later
    // edits take the UPDATE policy and must succeed.
    seedAiCostConfigMswState({
      rows: [{ tenant_id: TENANT_ID, seat_count: 5, cost_per_seat_usd: 10 }],
      forceInsertDenied: true,
    });

    const written = await aiCostService.upsertConfig(ctx(), { seatCount: 6, costPerSeatUsd: 11 });
    expect(written).toEqual({ seatCount: 6, costPerSeatUsd: 11 });
  });
});

describe("AiCostService module boundary", () => {
  it("never imports the RLS-bypassing admin client", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const text = await fs.readFile(path.resolve(__dirname, "./service.ts"), "utf8");
    expect(text).not.toContain("createSupabaseAdminClient");
    expect(text).not.toContain("getAdminDataClient");
  });
});
