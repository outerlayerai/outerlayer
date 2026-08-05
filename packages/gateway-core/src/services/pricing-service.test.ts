import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshModelPricing } from "@repo/llm-costs";
import { PricingService, createPricingService, kvRegistrySource } from "./pricing-service";
import type { GatewayCache, PricingData } from "../types";

// Mock @repo/llm-costs
vi.mock("@repo/llm-costs", () => ({
  modelsCostMapping: {
    "gpt-4-bundled": { promptPrice: 0.03, completionPrice: 0.06 },
  },
  refreshModelPricing: vi.fn().mockResolvedValue({ refreshed: true }),
}));

/**
 * Create a stub cache namespace for testing.
 * Returns a minimal implementation that satisfies the CacheNamespace interface.
 */
function createStubNamespace() {
  return {
    get: vi.fn().mockResolvedValue({ val: undefined }),
    set: vi.fn().mockResolvedValue({ val: undefined }),
    remove: vi.fn().mockResolvedValue({ val: undefined }),
    swr: vi.fn().mockResolvedValue({ val: undefined }),
  };
}

describe("PricingService", () => {
  const mockCacheGet = vi.fn();
  const mockCacheSet = vi.fn();

  const createMockCache = (): GatewayCache => ({
    userMeta: createStubNamespace(),
    featureFlags: createStubNamespace(),
    pricingData: {
      get: mockCacheGet,
      set: mockCacheSet,
      remove: vi.fn().mockResolvedValue({ val: undefined }),
      swr: vi.fn().mockResolvedValue({ val: undefined }),
    },
  } as GatewayCache);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPricingData", () => {
    it("should return cached data when cache hit", async () => {
      const cachedData: PricingData = {
        "gpt-4-cached": { promptPrice: 0.025, completionPrice: 0.05 },
      };
      mockCacheGet.mockResolvedValueOnce({ val: cachedData });

      const cache = createMockCache();
      const service = new PricingService(cache);

      const result = await service.getPricingData();

      expect(result).toEqual(cachedData);
      expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it("should return bundled data and cache it on cache miss", async () => {
      mockCacheGet.mockResolvedValueOnce({ val: null });

      const cache = createMockCache();
      const service = new PricingService(cache);

      const result = await service.getPricingData();

      expect(result).toEqual({
        "gpt-4-bundled": { promptPrice: 0.03, completionPrice: 0.06 },
      });
      expect(mockCacheSet).toHaveBeenCalledWith("llm-pricing-data", {
        "gpt-4-bundled": { promptPrice: 0.03, completionPrice: 0.06 },
      });
    });
  });

  describe("createPricingService", () => {
    it("should create a PricingService instance", () => {
      const cache = createMockCache();
      const service = createPricingService(cache);

      expect(service).toBeInstanceOf(PricingService);
    });
  });
});

describe("registry-backed refresh", () => {
  const kv = (value: string | null = "{}") => ({ get: vi.fn().mockResolvedValue(value) });

  const cacheMissing = (): GatewayCache => ({
    userMeta: createStubNamespace(),
    featureFlags: createStubNamespace(),
    pricingData: {
      get: vi.fn().mockResolvedValue({ val: null }),
      set: vi.fn().mockResolvedValue({ val: undefined }),
      remove: vi.fn().mockResolvedValue({ val: undefined }),
      swr: vi.fn().mockResolvedValue({ val: undefined }),
    },
  } as GatewayCache);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(refreshModelPricing).mockResolvedValue({ refreshed: true });
  });

  it("reads a KV binding as text — the shape the pricing refresh expects", async () => {
    const binding = kv('{"models":{}}');
    const source = kvRegistrySource(binding);
    await expect(source.get("models.json")).resolves.toBe('{"models":{}}');
    // "text" matters: the default returns a parsed value for JSON keys, and
    // the refresh parses the string itself.
    expect(binding.get).toHaveBeenCalledWith("models.json", "text");
  });

  it("refreshes from the source before serving the first uncached response", async () => {
    const source = kvRegistrySource(kv());
    await new PricingService(cacheMissing(), source).getPricingData();
    expect(vi.mocked(refreshModelPricing)).toHaveBeenCalledWith(source);
  });

  it("does not attempt a refresh when no source is bound", async () => {
    // Self-host and local dev have no namespace; bundled pricing is the right
    // answer there, not a failed lookup.
    await new PricingService(cacheMissing()).getPricingData();
    expect(vi.mocked(refreshModelPricing)).not.toHaveBeenCalled();
  });

  it("refreshes once per source, not once per request", async () => {
    const source = kvRegistrySource(kv());
    const cache = cacheMissing();
    await new PricingService(cache, source).getPricingData();
    await new PricingService(cache, source).getPricingData();
    expect(vi.mocked(refreshModelPricing)).toHaveBeenCalledTimes(1);
  });

  it("gives a distinct source its own refresh rather than reusing the first result", async () => {
    await new PricingService(cacheMissing(), kvRegistrySource(kv())).getPricingData();
    await new PricingService(cacheMissing(), kvRegistrySource(kv())).getPricingData();
    expect(vi.mocked(refreshModelPricing)).toHaveBeenCalledTimes(2);
  });

  it("warns when the refresh did not apply, naming the reason", async () => {
    // A silently-stale price map is indistinguishable from a fresh one until
    // someone notices a new model priced at zero — which is how the previous
    // source went unnoticed for months.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(refreshModelPricing).mockResolvedValue({ refreshed: false, reason: "absent" });
    await new PricingService(cacheMissing(), kvRegistrySource(kv(null))).getPricingData();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("absent"));
    warn.mockRestore();
  });

  it("does not warn when the refresh applied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new PricingService(cacheMissing(), kvRegistrySource(kv())).getPricingData();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still serves pricing when the refresh rejects", async () => {
    // The refresh runs on the request path; a rejection must degrade to
    // bundled pricing, never surface as a failed pricing response.
    vi.mocked(refreshModelPricing).mockRejectedValue(new Error("boom"));
    const result = await new PricingService(cacheMissing(), kvRegistrySource(kv())).getPricingData();
    expect(result).toEqual({ "gpt-4-bundled": { promptPrice: 0.03, completionPrice: 0.06 } });
  });

  it("skips the refresh entirely on a cache hit", async () => {
    const cache = cacheMissing();
    vi.mocked(cache.pricingData.get).mockResolvedValueOnce({
      val: { cached: { promptPrice: 1, completionPrice: 2 } },
    } as never);
    await new PricingService(cache, kvRegistrySource(kv())).getPricingData();
    expect(vi.mocked(refreshModelPricing)).not.toHaveBeenCalled();
  });
});

describe("refresh returning nothing", () => {
  const kvStub = { get: vi.fn().mockResolvedValue("{}") };

  const emptyCache = (): GatewayCache => ({
    userMeta: createStubNamespace(),
    featureFlags: createStubNamespace(),
    pricingData: {
      get: vi.fn().mockResolvedValue({ val: null }),
      set: vi.fn().mockResolvedValue({ val: undefined }),
      remove: vi.fn().mockResolvedValue({ val: undefined }),
      swr: vi.fn().mockResolvedValue({ val: undefined }),
    },
  } as GatewayCache);

  it("treats a refresh that resolves nothing as not-applied, and still serves pricing", async () => {
    // Guards the optional chaining: without it this throws inside the refresh
    // chain. That is not hypothetical — a stubbed refresh resolving undefined
    // is what surfaced the bug, and it ran at import time, where an unhandled
    // rejection takes down every importer of this module.
    vi.clearAllMocks();
    vi.mocked(refreshModelPricing).mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await new PricingService(emptyCache(), kvRegistrySource(kvStub)).getPricingData();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    expect(result).toEqual({ "gpt-4-bundled": { promptPrice: 0.03, completionPrice: 0.06 } });
    warn.mockRestore();
  });
});
