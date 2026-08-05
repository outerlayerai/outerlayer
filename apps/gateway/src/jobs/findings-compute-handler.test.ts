import { beforeEach, describe, expect, test, vi } from "vitest";
import { FINDINGS_COMPUTE_CRON, findingsComputeHandler } from "./findings-compute-handler";
import { createFindingsStore } from "../stores/clickhouse/findings-store";
import { createLoggerFromContext } from "../services/logger";
import { runFindingsCompute } from "../services/findings-compute-service";
import { createSystemAdminClient } from "@repo/gateway-core/lib/system-client";
import type { GatewayScheduleContext } from "@repo/gateway-core/types";

vi.mock("../stores/clickhouse/findings-store", () => ({
  createFindingsStore: vi.fn().mockReturnValue({ store: true }),
}));

vi.mock("../services/themes-llm-client", () => ({
  createThemesLlmClient: vi.fn().mockReturnValue({ model: "gpt-5-nano", complete: vi.fn() }),
}));

vi.mock("../services/logger", () => ({
  createLoggerFromContext: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock("@repo/gateway-core/lib/system-client", () => ({
  createSystemAdminClient: vi.fn().mockReturnValue({ admin: true }),
}));

vi.mock("../services/findings-compute-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/findings-compute-service")>();
  return { ...actual, runFindingsCompute: vi.fn().mockResolvedValue({}) };
});

function makeContext(envOverrides: Record<string, string> = {}): GatewayScheduleContext {
  return {
    env: {
      CLICKHOUSE_HOST: "http://ch.test:8123",
      CLICKHOUSE_PASSWORD: "pw",
      ...envOverrides,
    },
    event: { cron: FINDINGS_COMPUTE_CRON, scheduledTime: 1_700_000_000_000 },
    ctx: { waitUntil: vi.fn() },
    cache: {},
  } as unknown as GatewayScheduleContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findingsComputeHandler", () => {
  test("disabled (default) → bails before touching ClickHouse, Supabase, or the service", async () => {
    await findingsComputeHandler(makeContext());
    expect(createFindingsStore).not.toHaveBeenCalled();
    expect(createSystemAdminClient).not.toHaveBeenCalled();
    expect(runFindingsCompute).not.toHaveBeenCalled();
  });

  test("enabled → composes store + admin client + resolved config into the run", async () => {
    await findingsComputeHandler(
      makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }),
    );
    expect(createFindingsStore).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://ch.test:8123", password: "pw" }),
    );
    expect(runFindingsCompute).toHaveBeenCalledWith(
      expect.objectContaining({
        store: { store: true },
        supabase: { admin: true },
        config: expect.objectContaining({ enabled: true }),
        themesClient: expect.objectContaining({ model: "gpt-5-nano" }),
        // The unused-skills finding gets an inventory reader over the mirror.
        skillInventory: expect.objectContaining({ listInstalledSkills: expect.any(Function) }),
      }),
    );
    expect(createLoggerFromContext).toHaveBeenCalledWith(
      expect.anything(),
      { source: "scheduled:findings-compute" },
    );
  });

  test("the injected now() produces real Dates and the row-cap hook warns with the scope", async () => {
    const warn = vi.fn();
    (createLoggerFromContext as ReturnType<typeof vi.fn>).mockReturnValue({
      info: vi.fn(),
      warn,
    });
    await findingsComputeHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));

    const deps = (runFindingsCompute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      now: () => Date;
    };
    expect(deps.now()).toBeInstanceOf(Date);

    const storeConfig = (createFindingsStore as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      onRowCapHit: (scope: { tenantId: string; appId: string }, rows: number) => void;
    };
    storeConfig.onRowCapHit({ tenantId: "t1", appId: "a1" }, 200_000);
    expect(warn).toHaveBeenCalledWith(
      "span row cap hit — findings cover a subset of the window",
      { tenantId: "t1", appId: "a1", rows: 200_000 },
    );
  });
});
