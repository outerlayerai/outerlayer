import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "@repo/gateway-core/types";
import type { VerifyKeyResult } from "@repo/gateway-core/lib/verify-key";
import type { ResolveApiKeyParams } from "@repo/gateway-core/runtime/gateway-context";

// This adapter is a thin forward to the shared verifyKey (Unkey + cache), so we
// assert it passes the params through verbatim and returns the result unchanged.
// Hoisted so the vi.mock factory (lifted to file top) can reference it.
const { verifyKey } = vi.hoisted(() => ({ verifyKey: vi.fn() }));
vi.mock("@repo/gateway-core/lib/verify-key", () => ({ verifyKey }));

import { CloudflareAuthResolver } from "./cloudflare-auth-resolver";

const env = { NODE_ENV: "production" } as Env;

describe("CloudflareAuthResolver", () => {
  beforeEach(() => verifyKey.mockReset());

  it("forwards the full params to verifyKey and returns its result", async () => {
    const resolved = {
      ok: true,
      user: { appId: "app-1", tenantId: "tenant-1", appName: "A", permissions: [] },
    } as VerifyKeyResult;
    verifyKey.mockResolvedValue(resolved);

    const params: ResolveApiKeyParams = {
      authHeader: "Bearer sk_outerlayer_x",
      appId: "app-1",
      env,
      cacheKey: "app-1-hash",
    };
    const result = await new CloudflareAuthResolver().resolveApiKey(params);

    // The secret + cacheKey matter on the hosted path — pass everything through.
    expect(verifyKey).toHaveBeenCalledWith(params);
    expect(verifyKey).toHaveBeenCalledTimes(1);
    expect(result).toBe(resolved);
  });

  it("propagates an auth failure unchanged", async () => {
    const failure: VerifyKeyResult = { ok: false, status: 401, message: "invalid", code: "unauthorized" };
    verifyKey.mockResolvedValue(failure);

    const result = await new CloudflareAuthResolver().resolveApiKey({
      authHeader: "Bearer bad",
      appId: "app-1",
      env,
    });

    expect(result).toEqual({ ok: false, status: 401, message: "invalid", code: "unauthorized" });
  });
});
