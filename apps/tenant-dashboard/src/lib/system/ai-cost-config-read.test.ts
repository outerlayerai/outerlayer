/**
 * `fetchAiCostConfigForTenant` — the widget-route admin read. Real MSW
 * `ai_cost_config` table (no query-chain mocks), tenant-scoped by an
 * explicit argument since the admin client bypasses RLS entirely.
 */

import { seedAiCostConfigMswState } from "@/test-helpers/msw-handlers";

import { fetchAiCostConfigForTenant } from "./ai-cost-config-read";

const TENANT_ID = "tenant-1";
const OTHER_TENANT_ID = "tenant-2";

describe("fetchAiCostConfigForTenant", () => {
  it("returns the mapped config for the given tenantId", async () => {
    seedAiCostConfigMswState({
      rows: [{ tenant_id: TENANT_ID, seat_count: 20, cost_per_seat_usd: 99.5 }],
    });

    expect(await fetchAiCostConfigForTenant(TENANT_ID)).toEqual({
      seatCount: 20,
      costPerSeatUsd: 99.5,
    });
  });

  it("returns the zero config rather than throwing when no row exists — the widget must still render", async () => {
    seedAiCostConfigMswState({ rows: [] });

    expect(await fetchAiCostConfigForTenant(TENANT_ID)).toEqual({ seatCount: 0, costPerSeatUsd: 0 });
  });

  it("scopes strictly to the given tenantId — another tenant's row never leaks through", async () => {
    seedAiCostConfigMswState({
      rows: [{ tenant_id: OTHER_TENANT_ID, seat_count: 99, cost_per_seat_usd: 500 }],
    });

    expect(await fetchAiCostConfigForTenant(TENANT_ID)).toEqual({ seatCount: 0, costPerSeatUsd: 0 });
  });
});
