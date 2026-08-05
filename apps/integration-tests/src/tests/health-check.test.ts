import { CLICKHOUSE_TEST_HOST } from "../../clickhouse/setup-clickhouse";
import { HealthService } from "@repo/gateway-core/services/health";

// ClickHouse setup/teardown is handled by global setup in vitest.config.ts

describe("Health Check Integration Tests", () => {
  describe("Ingestion API Health (/health/ingestion)", () => {
    it("should return healthy status when ClickHouse is available", async () => {
      const healthService = new HealthService({
        clickhouseHost: CLICKHOUSE_TEST_HOST,
        clickhousePassword: "",
        supabaseUrl: "http://localhost:54321",
        supabaseKey: "test-key",
      });

      const result = await healthService.checkIngestion();

      expect(result.component).toBe("ingestion_api");
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
      expect(result.dependencies).toHaveLength(2);

      const clickhouseDep = result.dependencies.find((d) => d.name === "clickhouse");
      expect(clickhouseDep).toMatchObject({ name: "clickhouse" });
      expect(clickhouseDep!.status).toBe("healthy");
      expect(clickhouseDep!.latencyMs).toBeGreaterThanOrEqual(0);

      // Unkey is external — assert structure only (may be unreachable in CI)
      const unkeyDep = result.dependencies.find((d) => d.name === "unkey");
      expect(unkeyDep).toMatchObject({ name: "unkey" });
      expect(["healthy", "unhealthy"]).toContain(unkeyDep!.status);
      expect(unkeyDep!.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should return unhealthy status when ClickHouse is unavailable", async () => {
      const healthService = new HealthService({
        clickhouseHost: "http://localhost:9999",
        clickhousePassword: "",
        supabaseUrl: "http://localhost:54321",
        supabaseKey: "test-key",
      });

      const result = await healthService.checkIngestion();

      // ClickHouse is critical — even if Unkey is healthy, overall must be unhealthy
      expect(result.status).toBe("unhealthy");
      expect(result.component).toBe("ingestion_api");
      expect(result.dependencies).toHaveLength(2);

      const clickhouseDep = result.dependencies.find((d) => d.name === "clickhouse");
      expect(clickhouseDep).toMatchObject({ name: "clickhouse" });
      expect(clickhouseDep!.status).toBe("unhealthy");
      expect(typeof clickhouseDep!.error).toBe("string");
      expect(clickhouseDep!.error!.length).toBeGreaterThan(0);
    });
  });

  describe("Files API Health (/health/files)", () => {
    it("should check GitHub and Unkey status endpoints", async () => {
      const healthService = new HealthService({
        clickhouseHost: CLICKHOUSE_TEST_HOST,
        clickhousePassword: "",
        supabaseUrl: "http://localhost:54321",
        supabaseKey: "test-key",
      });

      const result = await healthService.checkFiles();

      expect(result.component).toBe("files_api");
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
      expect(result.dependencies).toHaveLength(3);

      const depNames = result.dependencies.map((d) => d.name);
      expect(depNames).toContain("supabase");
      expect(depNames).toContain("unkey");
      expect(depNames).toContain("github");

      // Verify dependencies were checked (latencyMs is set regardless of healthy/unhealthy)
      const github = result.dependencies.find((d) => d.name === "github");
      const unkey = result.dependencies.find((d) => d.name === "unkey");

      expect(github?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(unkey?.latencyMs).toBeGreaterThanOrEqual(0);

      // In CI, external APIs may be unreachable — only assert structure, not health status
      expect(["healthy", "unhealthy"]).toContain(github?.status);
      expect(["healthy", "unhealthy"]).toContain(unkey?.status);
    });

    it("should return unhealthy when critical dependency (Supabase) is down", async () => {
      const healthService = new HealthService({
        clickhouseHost: CLICKHOUSE_TEST_HOST,
        clickhousePassword: "",
        supabaseUrl: "http://invalid-supabase-url:9999",
        supabaseKey: "test-key",
      });

      const result = await healthService.checkFiles();

      expect(result.dependencies).toHaveLength(3);

      // Supabase is a critical dependency - when down, entire API is unhealthy
      const supabase = result.dependencies.find((d) => d.name === "supabase");
      expect(supabase?.status).toBe("unhealthy");

      // Overall status should be unhealthy (critical dependency down)
      expect(result.status).toBe("unhealthy");
    });
  });

  describe("Component Status Derivation", () => {
    it("should return valid ISO timestamp", async () => {
      const healthService = new HealthService({
        clickhouseHost: CLICKHOUSE_TEST_HOST,
        clickhousePassword: "",
        supabaseUrl: "http://localhost:54321",
        supabaseKey: "test-key",
      });

      const result = await healthService.checkIngestion();

      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });
  });
});
