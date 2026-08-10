import "server-only";

/**
 * Health Check Service
 *
 * Provides health checks for the tenant dashboard service.
 */

import { getAdminDataClient } from "@/lib/system/admin-client";
import { checkConfigPosture, postureEnvFromProcess } from "@/lib/system/env-readiness";

interface DependencyHealth {
  name: string;
  status: "healthy" | "unhealthy";
  latencyMs?: number;
  error?: string;
}

interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  service: string;
  dependencies: DependencyHealth[];
}

export const STATUS_CODE_MAP = {
  healthy: 200,
  degraded: 200,
  unhealthy: 503,
} as const;

// Critical dependencies - if any fail, status is "unhealthy"
const CRITICAL_DEPENDENCIES = ["supabase"];

export async function checkHealth(): Promise<HealthCheckResponse> {
  // Run all health checks in parallel
  const [supabaseHealth, clickhouseHealth] = await Promise.all([
    checkSupabase(),
    checkClickHouse(),
  ]);

  const dependencies = [supabaseHealth, clickhouseHealth, checkConfig()];

  // Determine overall status
  const criticalHealthy = dependencies
    .filter((d) => CRITICAL_DEPENDENCIES.includes(d.name))
    .every((d) => d.status === "healthy");

  const allHealthy = dependencies.every((d) => d.status === "healthy");

  let status: "healthy" | "degraded" | "unhealthy";
  if (allHealthy) {
    status = "healthy";
  } else if (criticalHealthy) {
    status = "degraded"; // Non-critical dependency down
  } else {
    status = "unhealthy"; // Critical dependency down
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    service: "tenant-dashboard",
    dependencies,
  };
}

/**
 * Config posture. Never unhealthy: missing config now fails the build (env.ts
 * validates on deployments), so anything this reports is a deliberate setting,
 * not a fault. "degraded" here means the deployment is doing less than a reader
 * of the code would assume — which is worth surfacing without paging anyone.
 *
 * Counted, not named: this route is unauthenticated, and naming which
 * capabilities are switched off hands a passer-by a map. `GET
 * /api/health/config` returns the detail to a caller holding CRON_SECRET.
 */
function checkConfig(): DependencyHealth {
  const { degraded } = checkConfigPosture(postureEnvFromProcess());
  if (degraded.length === 0) {
    return { name: "config", status: "healthy" };
  }
  return {
    name: "config",
    status: "unhealthy",
    error: `${degraded.length} capability(ies) reduced by configuration`,
  };
}

async function checkSupabase(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const supabase = getAdminDataClient();
    const { error } = await supabase.from("tenant").select("tenant_id").limit(1);
    const latencyMs = Date.now() - start;

    if (error) {
      return {
        name: "supabase",
        status: "unhealthy",
        latencyMs,
        error: error.message,
      };
    }

    return {
      name: "supabase",
      status: "healthy",
      latencyMs,
    };
  } catch (e) {
    return {
      name: "supabase",
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/**
 * Check ClickHouse health via the analytics API health endpoint.
 */
async function checkClickHouse(): Promise<DependencyHealth> {
  const start = Date.now();

  try {
    // Use the analytics health endpoint which checks ClickHouse connectivity
    const response = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || ''}/api/analytics/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    const latencyMs = Date.now() - start;

    if (response.ok) {
      const data = await response.json();
      if (data.status === "healthy") {
        return {
          name: "clickhouse",
          status: "healthy",
          latencyMs: data.dependencies?.clickhouse?.latencyMs || latencyMs,
        };
      }
    }

    return {
      name: "clickhouse",
      status: "unhealthy",
      latencyMs,
      error: `Analytics health check returned status ${response.status}`,
    };
  } catch (e) {
    return {
      name: "clickhouse",
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}
