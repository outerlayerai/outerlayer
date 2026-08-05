import type { ExecutionCtx } from "./runtime";
import {
  UserMeta,
  GatewayCache,
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayScheduleContext,
  PricingData,
  CachedFeatureFlag,
  CachedTierResolution,
  StorageCapCheckResult,
} from "./types";
import { Namespace, createCache } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import type { CacheL2Store } from "./runtime";
import { gte } from "semver";

type CacheOptions = {
  fresh?: number;
  stale?: number;
};

export const initCache = (
  cloudflare: CacheL2Store,
  ctx: ExecutionCtx | GatewayScheduleContext["ctx"],
  memory: MemoryStore<string, any>,
  options: CacheOptions = {}
): GatewayCache => {
  // The L2 store is injected (`gtx.cacheL2Store`): the Cloudflare KV-backed
  // store when hosted, a no-op store when self-hosting. The L1 `memory` store
  // is always present. initCache does not construct the CF store or read
  // CLOUDFLARE_* env — that lives in the composition root's adapter.
  // NOTE: This is the API key cache
  const userMetaNamespace = new Namespace<UserMeta>(ctx, {
    stores: [memory, cloudflare],
    fresh: options.fresh || 180_000, // Data is fresh for 180 seconds
    stale: options.stale || 300_000, // Data is stale for 300 seconds
  });
  const pricingDataNamespace = new Namespace<PricingData>(ctx, {
    stores: [memory, cloudflare],
    fresh: 86_400_000, // Data is fresh for 1 day (matches CDN cache)
    stale: 172_800_000, // Data is stale for 2 days (fallback while refreshing)
  });
  const featureFlagsNamespace = new Namespace<CachedFeatureFlag>(ctx, {
    stores: [memory, cloudflare],
    fresh: 60_000, // Data is fresh for 60 seconds
    stale: 300_000, // Data is stale for 5 minutes (use stale while revalidating)
  });
  // Quota namespaces for the ingest path. These ignore `options` on purpose —
  // the TTLs are a billing decision, not a per-caller knob.
  //
  // fresh === stale means no stale-while-revalidate window. A stale "hobby" for
  // someone who just upgraded blocks a paying customer, so 5 minutes is a hard
  // ceiling. Nothing clears this on upgrade: the Stripe webhook hits the
  // dashboard, which can't reach this worker's memory.
  const tenantEntitlementsNamespace = new Namespace<CachedTierResolution>(ctx, {
    stores: [memory, cloudflare],
    fresh: 300_000,
    stale: 300_000,
  });
  const spanUsageNamespace = new Namespace<number>(ctx, {
    stores: [memory, cloudflare],
    fresh: 60_000,
    stale: 60_000,
  });
  const storageCapNamespace = new Namespace<StorageCapCheckResult>(ctx, {
    stores: [memory, cloudflare],
    fresh: 300_000,
    stale: 300_000,
  });

  return createCache({
    userMeta: userMetaNamespace,
    pricingData: pricingDataNamespace,
    featureFlags: featureFlagsNamespace,
    tenantEntitlements: tenantEntitlementsNamespace,
    spanUsage: spanUsageNamespace,
    storageCap: storageCapNamespace,
  });
};

export const executePolicies = async (
  policies: Array<GatewayRequestHandler>,
  policyContext: GatewayRequestContext
) => {
  for (const policy of policies) {
    // Break early if any policy returns a response.
    const result = await policy(policyContext);
    if (result) {
      return result;
    }
  }
};

/**
 * Validates a user-provided path to prevent path traversal attacks.
 * Works in Cloudflare Workers environment (no Node.js path module).
 *
 * @param userPath - The path provided by the user
 * @throws Error if path contains traversal sequences
 * @returns The validated path with leading slashes removed
 */
export function buildDatasetPath(
  configVersion: string,
  promptsRootPath: string | undefined,
  configPath: string | undefined,
  filePath: string
): string {
  const isV2OrAbove = gte(configVersion || "0.0.0", "2.0.0");
  const rootPath = isV2OrAbove
    ? promptsRootPath || "/"
    : configPath || "/";
  // "agentmark" is the SDK's v2+ config-folder convention inside a user's
  // repo (config <2.0.0 used "templates") — this reads real repos, not our
  // branding, so the literal stays fixed regardless of product name.
  const folder = isV2OrAbove ? "agentmark" : "templates";
  const sanitizedFilePath = filePath.replace(/^(\.\/|\/)+/, "");
  const normalizedRootPath = (rootPath === "/" || rootPath === ".") ? "" : rootPath;
  return `${normalizedRootPath}/${folder}/${sanitizedFilePath}`.replace(/^\/+/, "");
}

export function validatePath(userPath: string): string {
  // First, decode any URL-encoded characters to catch encoded traversal attempts
  // This handles %2e%2e, %2E%2E, and double-encoded variants like %252e
  let decoded = userPath;
  try {
    // Keep decoding until stable (handles double/triple encoding)
    let prev = "";
    while (prev !== decoded) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    // If decoding fails, continue with original (malformed encoding)
  }

  // Normalize backslashes to forward slashes
  const normalized = decoded.replace(/\\/g, "/");

  // Check for path traversal sequences
  if (normalized.includes("..")) {
    throw new Error("Path traversal detected");
  }

  // Remove leading slashes but allow nested paths
  return normalized.replace(/^\/+/, "");
}
