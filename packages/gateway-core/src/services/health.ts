import { createClient } from "@clickhouse/client-web";
import type { DependencyHealth, ComponentHealth } from "../types/health";

export interface HealthServiceConfig {
  clickhouseHost: string;
  /** Write identity (`analytics_writer`); omit to fall back to `default`. */
  clickhouseUsername?: string;
  clickhousePassword: string;
  supabaseUrl: string;
  supabaseKey: string;
  /** When true, sanitizes error messages to avoid leaking internal details */
  isProduction?: boolean;
}

const GITHUB_STATUS_URL = "https://www.githubstatus.com/api/v2/status.json";
const UNKEY_LIVENESS_URL = "https://api.unkey.com/v2/liveness";

/** Health check timeout in milliseconds (5s to stay under 10s total) */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/** Generic error message for production to avoid leaking internal details */
const GENERIC_ERROR_MSG = "Connection failed";

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface IHealthService {
  checkIngestion(): Promise<ComponentHealth>;
  checkFiles(): Promise<ComponentHealth>;
}

export class HealthService implements IHealthService {
  constructor(private config: HealthServiceConfig) {}

  /**
   * Sanitize error message for external consumption.
   * In production, returns a generic message to avoid leaking internal details.
   *
   * Always logs the raw error to console.error so operators can surface it
   * via `wrangler tail` even when the public response is sanitized — the
   * sanitized message alone is not enough to diagnose a production health
   * failure.
   */
  private sanitizeError(error: unknown, context: string): string {
    const message = error instanceof Error ? error.message : "Unknown error";
    const name = error instanceof Error ? error.name : "Unknown";
    console.error(`[health-check:${context}] raw error:`, { name, message, error });
    return this.config.isProduction ? GENERIC_ERROR_MSG : message;
  }

  /**
   * Check Ingestion API health (traces, scores)
   * Dependencies:
   * - Critical: ClickHouse (unhealthy if down)
   * - Non-critical: Unkey (degraded if down)
   */
  async checkIngestion(): Promise<ComponentHealth> {
    const [clickhouseHealth, unkeyHealth] = await Promise.all([
      this.checkClickHouse(),
      this.checkUnkey(),
    ]);

    const dependencies = [clickhouseHealth, unkeyHealth];

    // ClickHouse is critical: ingestion writes land there.
    if (clickhouseHealth.status === "unhealthy") {
      return {
        status: "unhealthy",
        component: "ingestion_api",
        timestamp: new Date().toISOString(),
        dependencies,
      };
    }

    // Unkey backs burst rate limiting only, and that path fails open, so an
    // Unkey outage degrades ingestion rather than stopping it.
    return {
      status: unkeyHealth.status === "unhealthy" ? "degraded" : "healthy",
      component: "ingestion_api",
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  /**
   * Check Files/Templates API health
   * Dependencies:
   * - Critical: Supabase (unhealthy if down)
   * - Non-critical: Unkey, GitHub (degraded if down)
   */
  async checkFiles(): Promise<ComponentHealth> {
    // Check all dependencies in parallel
    const [supabaseHealth, unkeyHealth, githubHealth] = await Promise.all([
      this.checkSupabase(),
      this.checkUnkey(),
      this.checkGitHubStatus(),
    ]);

    const dependencies = [supabaseHealth, unkeyHealth, githubHealth];

    // Supabase is critical: it holds the rows every read serves.
    if (supabaseHealth.status === "unhealthy") {
      return {
        status: "unhealthy",
        component: "files_api",
        timestamp: new Date().toISOString(),
        dependencies,
      };
    }

    // Unkey (burst rate limiting, fails open) and GitHub are non-critical:
    // either being down degrades the API rather than stopping it.
    const nonCriticalDown =
      githubHealth.status === "unhealthy" || unkeyHealth.status === "unhealthy";

    return {
      status: nonCriticalDown ? "degraded" : "healthy",
      component: "files_api",
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  private async checkClickHouse(): Promise<DependencyHealth> {
    const start = Date.now();

    try {
      const client = createClient({
        url: this.config.clickhouseHost,
        ...(this.config.clickhouseUsername ? { username: this.config.clickhouseUsername } : {}),
        password: this.config.clickhousePassword,
        request_timeout: HEALTH_CHECK_TIMEOUT_MS,
      });

      await client.query({ query: "SELECT 1", format: "JSON" });
      await client.close();

      return {
        name: "clickhouse",
        status: "healthy",
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name: "clickhouse",
        status: "unhealthy",
        latencyMs: Date.now() - start,
        error: this.sanitizeError(error, "clickhouse"),
      };
    }
  }

  private async checkSupabase(): Promise<DependencyHealth> {
    const start = Date.now();

    try {
      // Probe `/auth/v1/health` (GoTrue liveness), not `/rest/v1/`.
      //
      // From a Cloudflare Worker, GET /rest/v1/ hangs for the full 5s
      // AbortController timeout on this specific origin (confirmed via
      // `wrangler tail` — every fetch logs AbortError). The same URL
      // responds in ~100ms from any other vantage point, and the
      // gateway's supabase-js consumers (createTenantScopedClient in
      // /v1/environments, /v1/api-keys) work fine — they hit /rest/v1/<table>
      // paths, never the bare root. Something in the Worker ↔ Supabase
      // edge interaction stalls specifically on GET /rest/v1/.
      //
      // /auth/v1/health is GoTrue's liveness probe, requires the same
      // apikey header, and answers fast. For a dependency health check
      // it's semantically equivalent: if Supabase's edge is reachable
      // and serving this path, the project is up.
      const response = await fetchWithTimeout(
        `${this.config.supabaseUrl}/auth/v1/health`,
        {
          method: "GET",
          headers: {
            apikey: this.config.supabaseKey,
          },
        }
      );

      // 5xx means Supabase itself is unhealthy. 2xx/3xx/4xx all indicate
      // the endpoint is reachable and serving — which is what we care
      // about for a dependency health check.
      if (response.status >= 500) {
        throw new Error(`Supabase API returned ${response.status}`);
      }

      return {
        name: "supabase",
        status: "healthy",
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name: "supabase",
        status: "unhealthy",
        latencyMs: Date.now() - start,
        error: this.sanitizeError(error, "supabase"),
      };
    }
  }

  /**
   * Check GitHub status using public status API (no auth, no rate limit)
   */
  private async checkGitHubStatus(): Promise<DependencyHealth> {
    const start = Date.now();

    try {
      const response = await fetchWithTimeout(GITHUB_STATUS_URL);
      if (!response.ok) {
        throw new Error(`GitHub status API returned ${response.status}`);
      }

      const data = (await response.json()) as { status: { indicator: string } };
      const isHealthy = data.status?.indicator === "none";

      return {
        name: "github",
        status: isHealthy ? "healthy" : "unhealthy",
        latencyMs: Date.now() - start,
        error: isHealthy ? undefined : `GitHub status: ${data.status?.indicator}`,
      };
    } catch (error) {
      return {
        name: "github",
        status: "unhealthy",
        latencyMs: Date.now() - start,
        error: this.sanitizeError(error, "github"),
      };
    }
  }

  /**
   * Check Unkey liveness (public endpoint, no auth required).
   * Unkey backs burst rate limiting only — API keys are verified against the
   * Postgres key store — and the rate-limit path fails open, so this is
   * reported as a non-critical dependency.
   */
  private async checkUnkey(): Promise<DependencyHealth> {
    const start = Date.now();

    try {
      const response = await fetchWithTimeout(UNKEY_LIVENESS_URL);
      if (!response.ok) {
        throw new Error(`Unkey liveness returned ${response.status}`);
      }

      return {
        name: "unkey",
        status: "healthy",
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name: "unkey",
        status: "unhealthy",
        latencyMs: Date.now() - start,
        error: this.sanitizeError(error, "unkey"),
      };
    }
  }

}

export function createHealthService(config: HealthServiceConfig): IHealthService {
  return new HealthService(config);
}
