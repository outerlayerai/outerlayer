import { describe, expect, test, vi } from "vitest";
import type { DetectionSession, Finding } from "@outerlayer/insights-core";
import type { FindingsStore } from "../stores/clickhouse/findings-store";
import {
  capPerDetector,
  resolveFindingsComputeConfig,
  runFindingsCompute,
  toFindingRows,
  type FindingsPersistClient,
} from "./findings-compute-service";

const NOW = new Date("2026-07-17T03:30:00.000Z");
const log = { info: vi.fn(), warn: vi.fn() };

/** A session with N consecutive failed edits to one file → edit-retry-loop fires at ≥3. */
function editLoopSession(id: string, failedEdits: number): DetectionSession {
  return {
    id,
    actorId: "a1",
    project: "github.com/acme/app",
    startedAt: "2026-07-16T10:00:00.000Z",
    models: ["claude-opus-4-8"],
    costUsd: 4,
    tokens: { input: 50_000, output: 4_000, cacheRead: 0, cacheCreation: 0 },
    isSubagent: 0,
    turns: [
      {
        index: 0,
        role: "assistant",
        ts: "2026-07-16T10:00:01.000Z",
        toolCalls: Array.from({ length: failedEdits }, () => ({
          name: "Edit",
          status: "error" as const,
          isEdit: true,
          file: "src/hot.ts",
          errorSignature: "old_string not found",
        })),
      },
    ],
    events: [],
  };
}

function cleanSession(id: string): DetectionSession {
  return { ...editLoopSession(id, 0), costUsd: 1 };
}

/** Chainable persist mock capturing deletes and inserts per table. */
function persistMock() {
  const deletes: { table: string; tenant: string; app: string }[] = [];
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const client: FindingsPersistClient = {
    from(table) {
      return {
        delete: () => ({
          eq: (_c: "tenant_id", tenant: string) => ({
            eq: async (_c2: "app_id", app: string) => {
              deletes.push({ table, tenant, app });
              return { error: null };
            },
          }),
        }),
        insert: async (rows: Record<string, unknown>[]) => {
          inserts.push({ table, rows });
          return { error: null };
        },
      };
    },
  };
  return { client, deletes, inserts };
}

describe("resolveFindingsComputeConfig", () => {
  test("defaults: disabled, empty allowlist, no key", () => {
    expect(resolveFindingsComputeConfig({})).toEqual({
      enabled: false,
      tenantAllowlist: [],
    });
  });

  test("rides the topics enrichment gate — same switch, same allowlist (trimmed, empties dropped)", () => {
    const config = resolveFindingsComputeConfig({
      TOPICS_ENRICHMENT_ENABLED: "true",
      TOPICS_TENANT_ALLOWLIST: " t1, t2 ,,",
    });
    expect(config).toEqual({
      enabled: true,
      tenantAllowlist: ["t1", "t2"],
    });
  });
});

describe("capPerDetector", () => {
  const f = (detectorId: string, costUsd: number | null): Finding => ({
    detectorId,
    severity: "high",
    sessionIds: ["s1"],
    summary: `${detectorId} @ ${costUsd}`,
    evidence: [],
    costUsd,
    timeMin: null,
  });

  test("keeps the top-N per detector by dollar rank; detectors are independent", () => {
    const kept = capPerDetector(
      [f("a", 1), f("a", 9), f("a", 5), f("b", 2), f("b", null)],
      2,
    );
    expect(kept.map((k) => k.summary)).toEqual(["a @ 9", "a @ 5", "b @ 2", "b @ null"]);
  });
});

describe("runFindingsCompute", () => {
  function makeStore(
    sessionsByTenant: Record<string, DetectionSession[]>,
    activatedByTenant: Record<string, string[]> = {},
  ): FindingsStore {
    return {
      listActiveScopes: vi
        .fn()
        .mockResolvedValue(
          Object.keys(sessionsByTenant).map((tenantId) => ({ tenantId, appId: `app-${tenantId}` })),
        ),
      loadDetectionSessions: vi.fn(async (scope) => sessionsByTenant[scope.tenantId] ?? []),
      loadActivatedSkills: vi.fn(async (scope) =>
        (activatedByTenant[scope.tenantId] ?? []).map((skillName) => ({
          skillName,
          totalActivations: 30,
          totalSessions: 10,
        })),
      ),
    };
  }

  const config = {
    enabled: true,
    tenantAllowlist: [] as string[],
  };

  test("real detectors run: an edit-retry corpus produces persisted, dollar-carrying finding rows", async () => {
    const sessions = [editLoopSession("s1", 4), cleanSession("s2"), cleanSession("s3")];
    const { client, deletes, inserts } = persistMock();
    const result = await runFindingsCompute({
      store: makeStore({ t1: sessions }),
      supabase: client,
      config,
      themesClient: null,
      skillInventory: null,
      log,
      now: () => NOW,
    });

    expect(result).toEqual(
      expect.objectContaining({ scopes: 1, computed: 1, skippedBelowFloor: 0, failed: 0 }),
    );
    // Replace-wholesale: both tables deleted for the scope before inserting.
    expect(deletes).toEqual([
      { table: "agent_finding", tenant: "t1", app: "app-t1" },
      { table: "agent_theme", tenant: "t1", app: "app-t1" },
    ]);

    const findingRows = inserts.find((i) => i.table === "agent_finding")!.rows;
    const editLoop = findingRows.find((r) => r.detector_id === "edit-retry-loop")!;
    expect(editLoop).toEqual(
      expect.objectContaining({
        tenant_id: "t1",
        app_id: "app-t1",
        severity: "high",
        session_ids: ["s1"],
        session_count: 1,
        project: "github.com/acme/app",
        computed_at: NOW.toISOString(),
      }),
    );
    expect(editLoop.cost_usd).toBeGreaterThan(0);
    // No key → themes degrade to zero rows, and findings still persist.
    expect(inserts.some((i) => i.table === "agent_theme" && i.rows.length > 0)).toBe(false);
  });

  test("scopes below the session floor compute nothing (calibration gate)", async () => {
    const { client, deletes } = persistMock();
    const result = await runFindingsCompute({
      store: makeStore({ t1: [editLoopSession("s1", 4)] }), // 1 session < floor 3
      supabase: client,
      config,
      themesClient: null,
      skillInventory: null,
      log,
      now: () => NOW,
    });
    expect(result).toEqual(
      expect.objectContaining({ scopes: 1, computed: 0, skippedBelowFloor: 1 }),
    );
    expect(deletes).toEqual([]);
  });

  test("the tenant allowlist filters scopes", async () => {
    const { client } = persistMock();
    const store = makeStore({ t1: [], t2: [] });
    const result = await runFindingsCompute({
      store,
      supabase: client,
      config: { ...config, tenantAllowlist: ["t2"] },
      themesClient: null,
      skillInventory: null,
      log,
      now: () => NOW,
    });
    expect(result.scopes).toBe(1);
    expect(store.loadDetectionSessions).toHaveBeenCalledTimes(1);
    expect(store.loadDetectionSessions).toHaveBeenCalledWith(
      { tenantId: "t2", appId: "app-t2" },
      14,
    );
  });

  test("one failing scope is isolated — the others still compute", async () => {
    const sessions = [editLoopSession("s1", 3), cleanSession("s2"), cleanSession("s3")];
    const store = makeStore({ bad: sessions, good: sessions });
    (store.loadDetectionSessions as ReturnType<typeof vi.fn>).mockImplementation(
      async (scope: { tenantId: string }) => {
        if (scope.tenantId === "bad") throw new Error("clickhouse down");
        return sessions;
      },
    );
    const { client } = persistMock();
    const result = await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory: null,
      log,
      now: () => NOW,
    });
    expect(result).toEqual(expect.objectContaining({ computed: 1, failed: 1 }));
  });

  const cleanCorpus = () => [cleanSession("s1"), cleanSession("s2"), cleanSession("s3")];
  const unusedRow = (rows: Record<string, unknown>[]) =>
    rows.find((r) => r.detector_id === "unused-skill");

  test("unused-skills finding: installed minus activated, appended with no sessions", async () => {
    const store = makeStore({ t1: cleanCorpus() }, { t1: ["review"] });
    const skillInventory = {
      listInstalledSkills: vi.fn(async () => ["review", "blog-writer", "deploy"]),
    };
    const { client, inserts } = persistMock();
    await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory,
      log,
      now: () => NOW,
    });

    expect(skillInventory.listInstalledSkills).toHaveBeenCalledWith("app-t1");
    // 90-day window (not the 14-day detection window) so a monthly skill isn't dead.
    expect(store.loadActivatedSkills).toHaveBeenCalledWith({ tenantId: "t1", appId: "app-t1" }, 90);

    const row = unusedRow(inserts.find((i) => i.table === "agent_finding")!.rows)!;
    expect(row).toEqual(
      expect.objectContaining({
        detector_id: "unused-skill",
        severity: "warn",
        session_count: 0,
        session_ids: [],
        cost_usd: null,
        project: null,
        summary: "2 installed skills never activated in 90 days: blog-writer, deploy",
      }),
    );
  });

  test("no unused-skills finding when every installed skill was activated", async () => {
    const store = makeStore({ t1: cleanCorpus() }, { t1: ["review"] });
    const { client, inserts } = persistMock();
    await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory: { listInstalledSkills: vi.fn(async () => ["review"]) },
      log,
      now: () => NOW,
    });
    expect(unusedRow(inserts.find((i) => i.table === "agent_finding")?.rows ?? [])).toBeUndefined();
  });

  test("unversioned-skills finding: relied-on skills outside the repo are flagged to promote", async () => {
    // `deep-research` activated (10 sessions via makeStore) but NOT installed;
    // `review` is installed and activated (no flag either way).
    const store = makeStore({ t1: cleanCorpus() }, { t1: ["review", "deep-research"] });
    const { client, inserts } = persistMock();
    await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory: { listInstalledSkills: vi.fn(async () => ["review"]) },
      log,
      now: () => NOW,
    });

    const rows = inserts.find((i) => i.table === "agent_finding")!.rows;
    const row = rows.find((r) => r.detector_id === "unversioned-skill")!;
    expect(row).toEqual(
      expect.objectContaining({
        detector_id: "unversioned-skill",
        severity: "warn",
        session_count: 0,
        session_ids: [],
        cost_usd: null,
        summary: "1 skill your sessions rely on isn't in the repo: deep-research (10 sessions)",
      }),
    );
    // The installed+activated skill triggers neither finding.
    expect(unusedRow(rows)).toBeUndefined();
  });

  test("a synced repo with zero skills still gets the unversioned finding, never the unused one", async () => {
    const store = makeStore({ t1: cleanCorpus() }, { t1: ["deep-research"] });
    const { client, inserts } = persistMock();
    await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      // [] = real repo, no skills installed — distinct from null (never synced).
      skillInventory: { listInstalledSkills: vi.fn(async () => []) },
      log,
      now: () => NOW,
    });
    const rows = inserts.find((i) => i.table === "agent_finding")!.rows;
    expect(rows.some((r) => r.detector_id === "unversioned-skill")).toBe(true);
    expect(unusedRow(rows)).toBeUndefined();
  });

  test("a never-synced mirror (null inventory) skips both skill findings", async () => {
    const store = makeStore({ t1: cleanCorpus() }, { t1: ["deep-research"] });
    const { client, inserts } = persistMock();
    await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory: { listInstalledSkills: vi.fn(async () => null) },
      log,
      now: () => NOW,
    });
    expect(store.loadActivatedSkills).not.toHaveBeenCalled();
    const rows = inserts.find((i) => i.table === "agent_finding")?.rows ?? [];
    expect(rows.some((r) => r.detector_id === "unversioned-skill" || r.detector_id === "unused-skill")).toBe(false);
  });

  test("skillInventory null → the finding is skipped and the activation query never runs", async () => {
    const store = makeStore({ t1: cleanCorpus() });
    const { client, inserts } = persistMock();
    await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory: null,
      log,
      now: () => NOW,
    });
    expect(store.loadActivatedSkills).not.toHaveBeenCalled();
    expect(unusedRow(inserts.find((i) => i.table === "agent_finding")?.rows ?? [])).toBeUndefined();
  });

  test("a mirror failure drops only the unused-skills finding — detector findings survive", async () => {
    const store = makeStore({ t1: [editLoopSession("s1", 4), cleanSession("s2"), cleanSession("s3")] });
    const skillInventory = {
      listInstalledSkills: vi.fn(async () => {
        throw new Error("mirror unreachable");
      }),
    };
    const { client, inserts } = persistMock();
    const result = await runFindingsCompute({
      store,
      supabase: client,
      config,
      themesClient: null,
      skillInventory,
      log,
      now: () => NOW,
    });

    // The scope still computed (not counted as failed) and the detector finding persisted.
    expect(result).toEqual(expect.objectContaining({ computed: 1, failed: 0 }));
    const rows = inserts.find((i) => i.table === "agent_finding")!.rows;
    expect(rows.some((r) => r.detector_id === "edit-retry-loop")).toBe(true);
    expect(unusedRow(rows)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "skill findings skipped for scope",
      expect.objectContaining({ appId: "app-t1", error: "mirror unreachable" }),
    );
  });
});

describe("toFindingRows", () => {
  test("caps session_ids at 8 while session_count keeps the full number", () => {
    const finding: Finding = {
      detectorId: "tool-error-cluster",
      severity: "high",
      sessionIds: Array.from({ length: 12 }, (_, i) => `s${i}`),
      summary: "x",
      evidence: [],
      costUsd: 3,
      timeMin: null,
    };
    const rows = toFindingRows(
      { tenantId: "t1", appId: "a1" },
      [finding],
      [cleanSession("s0")],
      NOW.toISOString(),
    );
    expect(rows[0]!.session_count).toBe(12);
    expect(rows[0]!.session_ids).toHaveLength(8);
    expect(rows[0]!.project).toBe("github.com/acme/app");
  });
});

describe("runFindingsCompute theme labeling on the topics provider stack", () => {
  test("a themes client labels the deterministic clusters and rows persist with OUR evidence ids", async () => {
    const sessions = [editLoopSession("s1", 4), cleanSession("s2"), cleanSession("s3")];
    const { client, inserts } = persistMock();
    const themesClient = {
      model: "gpt-5-nano",
      complete: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            label: "Stale file reads",
            description: "Edits repeatedly failing against stale file content.",
            clusterKeys: ["Edit::old_string not found"],
            severity: "warn",
          },
        ]),
      ),
    };
    await runFindingsCompute({
      store: {
        listActiveScopes: vi.fn().mockResolvedValue([{ tenantId: "t1", appId: "app-t1" }]),
        loadDetectionSessions: vi.fn().mockResolvedValue(sessions),
        loadActivatedSkills: vi.fn().mockResolvedValue([]),
      },
      supabase: client,
      config: { enabled: true, tenantAllowlist: [] },
      themesClient,
      skillInventory: null,
      log,
      now: () => NOW,
    });

    expect(themesClient.complete).toHaveBeenCalledTimes(1);
    const themeRows = inserts.find((i) => i.table === "agent_theme")!.rows;
    expect(themeRows).toEqual([
      expect.objectContaining({
        label: "Stale file reads",
        severity: "warn",
        cluster_keys: ["Edit::old_string not found"],
        // Evidence ids come from OUR clusters, never from model output.
        evidence_session_ids: ["s1"],
      }),
    ]);
  });
});
