import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { HealthService, createHealthService } from "./health";
import { server } from "../test-helpers/msw-server";

// Mock ClickHouse client
const mockQuery = vi.fn();
const mockClose = vi.fn();

vi.mock("@clickhouse/client-web", () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    close: mockClose,
  })),
}));

function unkeyHealthy() {
  return HttpResponse.json({}, { status: 200 });
}

function githubHealthy() {
  return HttpResponse.json({ status: { indicator: "none" } }, { status: 200 });
}

function githubMajor() {
  return HttpResponse.json({ status: { indicator: "major" } }, { status: 200 });
}

function stubHealthFetches(overrides: {
  supabase?: () => Response | Promise<Response>;
  unkey?: () => Response | Promise<Response>;
  github?: () => Response | Promise<Response>;
}) {
  let callCount = 0;

  server.use(
    http.get("http://localhost:54321/auth/v1/health", () => {
      callCount += 1;
      return overrides.supabase ? overrides.supabase() : HttpResponse.json({}, { status: 401 });
    }),
    http.get("https://api.unkey.com/v2/liveness", () => {
      callCount += 1;
      return overrides.unkey ? overrides.unkey() : unkeyHealthy();
    }),
    http.get("https://www.githubstatus.com/api/v2/status.json", () => {
      callCount += 1;
      return overrides.github ? overrides.github() : githubHealthy();
    }),
  );

  return {
    getCallCount() {
      return callCount;
    },
  };
}

describe("HealthService", () => {
  const defaultConfig = {
    clickhouseHost: "http://localhost:8123",
    clickhousePassword: "test-password",
    supabaseUrl: "http://localhost:54321",
    supabaseKey: "test-key",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("checkIngestion", () => {
    it("returns healthy when ClickHouse responds", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkIngestion();

      expect(result.status).toBe("healthy");
      expect(result.component).toBe("ingestion_api");
      expect(result.dependencies).toHaveLength(2);

      const clickhouseDep = result.dependencies.find((d) => d.name === "clickhouse");
      expect(clickhouseDep?.status).toBe("healthy");
      expect(typeof clickhouseDep?.latencyMs).toBe("number");
      expect(clickhouseDep!.latencyMs).toBeGreaterThanOrEqual(0);
      expect(clickhouseDep?.error).toBeUndefined();

      const unkeyDep = result.dependencies.find((d) => d.name === "unkey");
      expect(unkeyDep?.status).toBe("healthy");
    });

    it("returns unhealthy when ClickHouse fails", async () => {
      mockQuery.mockRejectedValue(new Error("Connection refused"));
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkIngestion();

      expect(result.status).toBe("unhealthy");
      const clickhouseDep = result.dependencies.find((d) => d.name === "clickhouse");
      expect(clickhouseDep?.status).toBe("unhealthy");
      expect(clickhouseDep?.error).toBe("Connection refused");
    });

    it("returns degraded when Unkey (non-critical) fails", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      stubHealthFetches({
        unkey: () => HttpResponse.json({}, { status: 503 }),
      });

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkIngestion();

      // Unkey backs burst rate limiting only, and that path fails open, so its
      // liveness must not take ingestion unhealthy while ClickHouse is fine.
      expect(result.status).toBe("degraded");
      const unkeyDep = result.dependencies.find((d) => d.name === "unkey");
      expect(unkeyDep?.status).toBe("unhealthy");
    });

    it("handles unknown error types", async () => {
      mockQuery.mockRejectedValue("string error");
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkIngestion();

      expect(result.status).toBe("unhealthy");
      const clickhouseDep = result.dependencies.find((d) => d.name === "clickhouse");
      expect(clickhouseDep?.error).toBe("Unknown error");
    });

    it("closes ClickHouse client after successful query", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      await service.checkIngestion();

      expect(mockClose).toHaveBeenCalledOnce();
    });
  });

  describe("checkFiles", () => {
    it("returns healthy when all dependencies respond", async () => {
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      expect(result.status).toBe("healthy");
      expect(result.component).toBe("files_api");
      expect(result.dependencies).toHaveLength(3);

      const supabase = result.dependencies.find((d) => d.name === "supabase");
      const unkey = result.dependencies.find((d) => d.name === "unkey");
      const github = result.dependencies.find((d) => d.name === "github");

      expect(supabase?.status).toBe("healthy");
      expect(unkey?.status).toBe("healthy");
      expect(github?.status).toBe("healthy");
    });

    it("returns unhealthy when Supabase (critical) is down", async () => {
      stubHealthFetches({
        supabase: () => HttpResponse.json({}, { status: 500 }),
      });

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      expect(result.status).toBe("unhealthy");
      expect(result.dependencies.find((d) => d.name === "supabase")?.status).toBe(
        "unhealthy"
      );
    });

    // Regression: Supabase's actual response to GET /rest/v1/ without a
    // valid session is 401 (not 400, as the previous guard assumed).
    // A 401 indicates the endpoint is REACHABLE — that's what the health
    // check cares about — so the dependency must be marked healthy.
    // Before the fix, the guard `response.status !== 400` treated 401 as
    // a failure, and every staging deploy reported Supabase unhealthy.
    it("returns healthy when Supabase responds with 401 (reachable, auth-gated)", async () => {
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      expect(result.dependencies.find((d) => d.name === "supabase")?.status).toBe(
        "healthy"
      );
      expect(result.status).toBe("healthy");
    });

    // Lock in `/auth/v1/health` (GoTrue liveness), not `/rest/v1/`.
    // From a Cloudflare Worker, GET /rest/v1/ on *.supabase.co hangs
    // the full 5s AbortController timeout — confirmed via wrangler tail
    // showing AbortError every invocation — while curl from elsewhere
    // returns 401 in ~100ms. /auth/v1/health responds fast from Workers
    // and is semantically equivalent for a dependency probe.
    it("probes /auth/v1/health, not /rest/v1/", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      stubHealthFetches({});

      const service = new HealthService(defaultConfig);
      vi.useRealTimers();
      await service.checkFiles();

      const supabaseCall = fetchSpy.mock.calls.find(([url]) =>
        typeof url === "string" && url.startsWith(defaultConfig.supabaseUrl)
      );
      const url = supabaseCall![0] as string;
      expect(url).toContain("/auth/v1/health");
      expect(url).not.toContain("/rest/v1/");
      const init = supabaseCall![1] as RequestInit;
      expect(init?.method).toBe("GET");
      fetchSpy.mockRestore();
    });

    it("returns degraded when Unkey (non-critical) is down", async () => {
      stubHealthFetches({
        unkey: () => HttpResponse.json({}, { status: 503 }),
      });

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      expect(result.status).toBe("degraded");
      expect(result.dependencies.find((d) => d.name === "unkey")?.status).toBe(
        "unhealthy"
      );
    });

    it("returns degraded when GitHub (non-critical) is down", async () => {
      stubHealthFetches({
        github: () => githubMajor(),
      });

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      expect(result.status).toBe("degraded");
      expect(result.dependencies.find((d) => d.name === "github")?.status).toBe(
        "unhealthy"
      );
    });

    it("handles fetch network errors", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/auth/v1/health")) {
          return Promise.reject(new Error("Network error"));
        }
        if (url.includes("api.unkey.com")) {
          return Promise.resolve(unkeyHealthy());
        }
        if (url.includes("githubstatus.com")) {
          return Promise.resolve(githubHealthy());
        }
        return Promise.resolve(HttpResponse.json({}, { status: 404 }));
      });

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      // Supabase is critical, so this should be unhealthy
      expect(result.status).toBe("unhealthy");
      expect(result.dependencies.find((d) => d.name === "supabase")?.error).toBe(
        "Network error"
      );
      fetchSpy.mockRestore();
    });

    it("handles GitHub status API errors", async () => {
      stubHealthFetches({
        github: () => HttpResponse.json({}, { status: 500 }),
      });

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      const result = await service.checkFiles();

      expect(result.status).toBe("degraded");
      expect(result.dependencies.find((d) => d.name === "github")?.status).toBe(
        "unhealthy"
      );
    });

    it("runs all health checks in parallel", async () => {
      const tracker = stubHealthFetches({});

      const service = new HealthService(defaultConfig);

      vi.useRealTimers();
      await service.checkFiles();

      expect(tracker.getCallCount()).toBe(3);
    });
  });

  describe("createHealthService", () => {
    it("creates a HealthService instance", () => {
      const service = createHealthService(defaultConfig);
      expect(service).toBeInstanceOf(HealthService);
    });
  });

  describe("timeout handling", () => {
    it("should abort request on timeout", async () => {
      server.use(
        http.get("http://localhost:54321/auth/v1/health", ({ request }) => {
          return new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          });
        }),
        http.get("https://api.unkey.com/v2/liveness", () => unkeyHealthy()),
        http.get("https://www.githubstatus.com/api/v2/status.json", () => githubHealthy()),
      );

      const service = new HealthService(defaultConfig);

      // Keep fake timers so we can advance past the 5s timeout instantly
      const resultPromise = service.checkFiles();
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      // Should return unhealthy due to timeout
      expect(result.status).toBe("unhealthy");
    });
  });
});
