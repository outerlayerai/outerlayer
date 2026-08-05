import { z } from "zod";

/**
 * Status of a single dependency
 */
export const DependencyHealthSchema = z.object({
  /** Name of the dependency */
  name: z.string().min(1),
  /** Current status */
  status: z.enum(["healthy", "unhealthy"]),
  /** Response time in milliseconds (optional) */
  latencyMs: z.number().optional(),
  /** Error message if unhealthy (optional) */
  error: z.string().optional(),
});

export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

/**
 * Response from a health check endpoint
 */
export const HealthCheckResponseSchema = z.object({
  /** Overall service status */
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  /** When the check was performed (ISO 8601) */
  timestamp: z.string().datetime(),
  /** Name of the service */
  service: z.string().min(1),
  /** Service version (optional) */
  version: z.string().optional(),
  /** Status of each dependency */
  dependencies: z.array(DependencyHealthSchema),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

/**
 * Component health (internal use)
 */
export interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy";
  component: string;
  timestamp: string;
  dependencies: DependencyHealth[];
}

/**
 * HTTP status code mapping for health check responses
 */
export const STATUS_CODE_MAP = {
  healthy: 200,
  degraded: 200, // Still operational, non-critical deps down
  unhealthy: 503,
} as const;

/**
 * Latency thresholds for dependency health status (in milliseconds)
 * - healthy: < 2000ms
 * - degraded: 2000-10000ms
 * - unhealthy: > 10000ms or error
 */
export const LATENCY_THRESHOLDS = {
  HEALTHY_MAX_MS: 2000,
  DEGRADED_MAX_MS: 10000,
} as const;

/**
 * Derive overall status from dependencies:
 * - healthy: all dependencies healthy
 * - degraded: some dependencies healthy (partial functionality)
 * - unhealthy: all dependencies unhealthy (no functionality)
 */
export function deriveOverallStatus(
  dependencies: DependencyHealth[]
): "healthy" | "degraded" | "unhealthy" {
  if (dependencies.length === 0) {
    return "healthy";
  }

  const healthyCount = dependencies.filter((d) => d.status === "healthy").length;

  if (healthyCount === dependencies.length) {
    return "healthy";
  }
  if (healthyCount === 0) {
    return "unhealthy";
  }
  return "degraded";
}

/**
 * Determine dependency status based on latency
 */
export function getStatusFromLatency(latencyMs: number): "healthy" | "unhealthy" {
  return latencyMs <= LATENCY_THRESHOLDS.DEGRADED_MAX_MS ? "healthy" : "unhealthy";
}
