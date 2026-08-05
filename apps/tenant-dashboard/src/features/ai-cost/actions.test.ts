/**
 * updateAiCostConfigAction — the glue around `authorizedAction`: gated
 * `ai_cost_config.update`, writes through the resolved request context
 * (never a client-supplied tenant id), and re-seeds the AI-costs React Server Component (RSC) on
 * success. The context + permission seams are mocked; the write runs for
 * real against the MSW `ai_cost_config` table.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedAiCostConfigMswState } from "@/test-helpers/msw-handlers";

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { updateAiCostConfigAction } from "./actions";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-2222-2222-222222222222";
const AI_COSTS_SETTINGS_PATH = "/orgs/[orgName]/settings/ai-costs";

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: TENANT_ID,
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

it("upserts the request-context tenant's config, authorizes on ai_cost_config.update, and revalidates", async () => {
  seedAiCostConfigMswState({ rows: [] });

  const res = await updateAiCostConfigAction({ seatCount: 5, costPerSeatUsd: 20 });

  expect(res).toEqual({ ok: true, data: { seatCount: 5, costPerSeatUsd: 20 } });
  expect(checkPermMock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user-1" }),
    "ai_cost_config.update",
    undefined,
  );
  expect(revalidateMock).toHaveBeenCalledWith(AI_COSTS_SETTINGS_PATH, "page");
});

// Proves AC-6: a member of tenant A whose JWT still carries a stale
// tenant_id claim for tenant B must have their submission land on tenant
// A's row — the claim never selects the target tenant. Regression class
// commit 3e2c181f proved on org-settings.
it("ignores a client-supplied tenantId — the write always targets the resolved request tenant", async () => {
  seedAiCostConfigMswState({ rows: [] });

  const res = await updateAiCostConfigAction({
    seatCount: 5,
    costPerSeatUsd: 20,
    tenantId: OTHER_TENANT_ID,
  });

  expect(res).toEqual({ ok: true, data: { seatCount: 5, costPerSeatUsd: 20 } });

  const written = (
    await createMswRestClient()
      .from("ai_cost_config")
      .select("tenant_id, seat_count, cost_per_seat_usd")
      .eq("tenant_id", TENANT_ID)
      .single()
  ).data;
  expect(written).toEqual({ tenant_id: TENANT_ID, seat_count: 5, cost_per_seat_usd: 20 });

  const otherTenantRow = (
    await createMswRestClient()
      .from("ai_cost_config")
      .select("tenant_id")
      .eq("tenant_id", OTHER_TENANT_ID)
  ).data;
  expect(otherTenantRow).toEqual([]);
});

it("denies an actor lacking ai_cost_config.update, writing nothing and not revalidating", async () => {
  checkPermMock.mockResolvedValue(false);
  seedAiCostConfigMswState({ rows: [] });

  const res = await updateAiCostConfigAction({ seatCount: 5, costPerSeatUsd: 20 });

  expect(res).toEqual({
    ok: false,
    error: { code: "forbidden", message: "Permission denied: ai_cost_config.update" },
  });
  expect(revalidateMock).not.toHaveBeenCalled();
  const rows = (await createMswRestClient().from("ai_cost_config").select("tenant_id")).data;
  expect(rows).toEqual([]);
});

it("rejects a negative seat count before touching the context (validation error)", async () => {
  const res = await updateAiCostConfigAction({ seatCount: -3, costPerSeatUsd: 20 });

  expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(loadCtxMock).not.toHaveBeenCalled();
});

// Proves AC-7: a role holding ai_cost_config.update but not .insert is
// denied at the DB on a tenant's first-ever configure (fail-closed, D-6) —
// the caller must see an error, not a success.
it("surfaces a fail-closed insert denial as a typed failure instead of a silent success", async () => {
  seedAiCostConfigMswState({ rows: [], forceInsertDenied: true });

  const res = await updateAiCostConfigAction({ seatCount: 5, costPerSeatUsd: 20 });

  expect(res).toMatchObject({ ok: false, error: { code: "internal_error" } });
  expect(revalidateMock).not.toHaveBeenCalled();
  const rows = (await createMswRestClient().from("ai_cost_config").select("tenant_id")).data;
  expect(rows).toEqual([]);
});
