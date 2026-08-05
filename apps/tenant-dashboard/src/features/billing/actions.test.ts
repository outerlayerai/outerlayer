/**
 * The four billing actions — the glue around `authorizedAction`: each
 * authorizes its permission (billing.insert/update/read) against the
 * resolved request tenant, never the JWT claim, before calling the one
 * service method. `getBillingPageState` requires `billing.read` like every
 * other billing read — no action here runs ungated.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";

const { loadCtxMock, checkPermMock, getPageStateMock, createCheckoutMock, upgradeMock, createPortalMock } =
  vi.hoisted(() => ({
    loadCtxMock: vi.fn(),
    checkPermMock: vi.fn(),
    getPageStateMock: vi.fn(),
    createCheckoutMock: vi.fn(),
    upgradeMock: vi.fn(),
    createPortalMock: vi.fn(),
  }));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("./service", () => ({
  billingService: {
    getPageState: getPageStateMock,
    createCheckoutSession: createCheckoutMock,
    upgradeSubscription: upgradeMock,
    createPortalSession: createPortalMock,
  },
}));

import {
  createCheckoutSession,
  upgradeSubscription,
  getBillingPageState,
  createPortalSession,
} from "./actions";

const TENANT_ID = "tenant-1";

function ctx(): ServiceContext {
  return { db: {} as never, tenantId: TENANT_ID, actor: { userId: "user-1", role: "owner" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCtxMock.mockResolvedValue(ctx());
  checkPermMock.mockResolvedValue(true);
});

describe("createCheckoutSession", () => {
  it("authorizes on billing.insert and returns the checkout url", async () => {
    createCheckoutMock.mockResolvedValue("https://checkout.stripe.com/c/ok");

    const res = await createCheckoutSession({ redirectTo: "https://app.example.com", tierId: "growth" });

    expect(res).toEqual({ ok: true, data: "https://checkout.stripe.com/c/ok" });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), "billing.insert", undefined);
    expect(createCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }), {
      redirectTo: "https://app.example.com",
      tierId: "growth",
    });
  });

  it("denies without calling the service when billing.insert is missing", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await createCheckoutSession({ redirectTo: "https://app.example.com", tierId: "growth" });

    expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "Permission denied: billing.insert" } });
    expect(createCheckoutMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid tier before resolving context (validation error)", async () => {
    const res = await createCheckoutSession({ redirectTo: "https://app.example.com", tierId: "not-a-tier" });

    expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect(loadCtxMock).not.toHaveBeenCalled();
  });
});

describe("upgradeSubscription", () => {
  it("authorizes on billing.update and returns the service result", async () => {
    upgradeMock.mockResolvedValue({ success: true });

    const res = await upgradeSubscription({ tierId: "team" });

    expect(res).toEqual({ ok: true, data: { success: true } });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), "billing.update", undefined);
  });

  it("surfaces subscription_canceled as a typed failure message", async () => {
    upgradeMock.mockRejectedValue(new Error("subscription_canceled"));

    const res = await upgradeSubscription({ tierId: "team" });

    expect(res).toEqual({ ok: false, error: { code: "internal_error", message: "subscription_canceled" } });
  });
});

describe("getBillingPageState", () => {
  it("authorizes on billing.read and returns the page state", async () => {
    getPageStateMock.mockResolvedValue({ units: 10, storageGb: 1, isCancelling: false, tierId: "growth" });

    const res = await getBillingPageState({});

    expect(res).toEqual({ ok: true, data: { units: 10, storageGb: 1, isCancelling: false, tierId: "growth" } });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), "billing.read", undefined);
  });

  it("denies a caller lacking billing.read without calling the service", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await getBillingPageState({});

    expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "Permission denied: billing.read" } });
    expect(getPageStateMock).not.toHaveBeenCalled();
  });
});

describe("createPortalSession", () => {
  it("authorizes on billing.update and returns the portal url", async () => {
    createPortalMock.mockResolvedValue("https://billing.stripe.com/p/ok");

    const res = await createPortalSession({ redirectTo: "https://app.example.com/back" });

    expect(res).toEqual({ ok: true, data: "https://billing.stripe.com/p/ok" });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), "billing.update", undefined);
  });

  it("denies without calling the service when billing.update is missing", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await createPortalSession({ redirectTo: "https://app.example.com/back" });

    expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "Permission denied: billing.update" } });
    expect(createPortalMock).not.toHaveBeenCalled();
  });
});
