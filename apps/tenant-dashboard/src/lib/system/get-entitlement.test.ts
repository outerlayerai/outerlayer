/**
 * `getEntitlement` — the canonical admin boolean-entitlement gate. Real MSW
 * `billing`/`tenant_entitlement_override` tables (no query-chain mocks), so
 * the override → tier → hobby-default resolution order is exercised for
 * real, the same ground `EntitlementService.canAccess`'s own suite covers —
 * this pins that the two homes agree.
 */

import { seedSupabaseMswState } from "@/test-helpers/msw-handlers";

import { getEntitlement } from "./get-entitlement";

const TENANT = "tenant-1";

describe("getEntitlement", () => {
  it("resolves true when the tier grants the boolean entitlement", async () => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT, tier_id: "growth" }] });
    expect(await getEntitlement(TENANT, "preview_envs")).toBe(true);
  });

  it("resolves false when the tier denies the boolean entitlement", async () => {
    seedSupabaseMswState({ billing: [{ tenant_id: TENANT, tier_id: "hobby" }] });
    expect(await getEntitlement(TENANT, "preview_envs")).toBe(false);
  });

  it("an override grants access despite the tier denying it", async () => {
    seedSupabaseMswState({
      billing: [{ tenant_id: TENANT, tier_id: "hobby" }],
      tenantEntitlementOverrides: [
        { id: "ov-1", tenant_id: TENANT, entitlement_key: "preview_envs", value: { v: true } },
      ],
    });
    expect(await getEntitlement(TENANT, "preview_envs")).toBe(true);
  });

  it("defaults to the hobby tier when no billing row exists", async () => {
    seedSupabaseMswState({ billing: [] });
    expect(await getEntitlement(TENANT, "preview_envs")).toBe(false);
  });
});

describe("getEntitlement — self-host mode", () => {
  beforeEach(() => {
    vi.stubEnv("OUTERLAYER_SELF_HOSTED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves an EE key by license state without any DB read", async () => {
    // No MSW state seeded — a DB read here would fail the request, which is
    // exactly the regression an accidental billing-table read would cause.
    expect(await getEntitlement(TENANT, "custom_sso")).toBe(false);
  });
});
