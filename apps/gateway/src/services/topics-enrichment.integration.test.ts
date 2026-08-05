/**
 * REAL-ClickHouse integration for topics enrichment. Runs the actual
 * TopicsEnrichmentService (mock LLM, but real feature-hash embeddings and the
 * real ClickHouse store) against a local ClickHouse to prove the per-correction
 * steering theories end to end — not against a fake client.
 *
 * Requires a local ClickHouse migrated to >= 38 (docker compose in
 * apps/tenant-dashboard/clickhouse). Gated behind RUN_CH_INTEGRATION so normal
 * CI (no ClickHouse) skips it:
 *   RUN_CH_INTEGRATION=1 yarn vitest run src/services/topics-enrichment.integration.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@clickhouse/client-web";
import { MockTopicsModelClient, STEERING_EXTRACTOR_VERSION } from "@repo/trace-topics";
import { createTopicsStore } from "../stores/clickhouse/topics-store";
import {
  TopicsEnrichmentService,
  resolveTopicsConfig,
} from "./topics-enrichment-service";

const CH_URL = process.env.CH_URL ?? "http://localhost:8123";
const CH_PASSWORD = process.env.CH_PASSWORD ?? "dev_password";
const RUN = process.env.RUN_CH_INTEGRATION === "1";

// Unique per run: enrichment is allowlist-scoped to TENANT, so a fresh id
// isolates each run with zero cleanup (no heavyweight DELETE on the
// projection-carrying otel_traces).
const RUN_ID = Math.random().toString(36).slice(2, 10);
const TENANT = `it-tenant-enrich-${RUN_ID}`;
const APP = "it-app-enrich";
const ENV = "dev";

// Trace ids must be unique PER RUN: the candidate scan's already-enriched
// anti-join is global-by-TraceId (correct — real W3C trace ids are globally
// unique), so a reused id would be excluded by a prior run's facet rows.
const trace = (suffix: string) => (RUN_ID + suffix).padEnd(32, "0").slice(0, 32);
const TR_MULTI = trace("multi");
const TR_SINGLE = trace("single");
const TR_NULL = trace("nulltext");
const TR_MONSTER = trace("monster");

const admin = createClient({ url: CH_URL, password: CH_PASSWORD, database: "default" });

/** CH DateTime64(9) / DateTime literal formatters. */
const dt64 = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "000000";
const dt = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "").slice(0, 19);

interface Turn { role: "user" | "assistant"; text: string }

/**
 * Seed one agent session: an agent.session root + one agent.turn.* span per
 * turn, plus its agent_session_summary rollup row. Timestamps are backdated
 * past the debounce so the candidate scan sees the trace as quiet.
 */
async function seedSession(traceId: string, turns: Turn[], opts: { parentSessionId?: string; origin?: string } = {}) {
  const base = Date.now() - 30 * 60 * 1000; // 30 min ago
  const rows: Record<string, unknown>[] = [
    {
      TenantId: TENANT, AppId: APP, Environment: ENV, TraceId: traceId,
      SpanId: `${traceId.slice(0, 12)}root`, ParentSpanId: "", SpanName: "agent.session",
      Type: "SPAN", Timestamp: dt64(base), Input: "", Output: "",
      CreatedAt: dt(Date.now()), IsDeleted: 0, StatusCode: "STATUS_CODE_OK", Duration: 0, Cost: 0,
    },
  ];
  turns.forEach((turn, i) => {
    rows.push({
      TenantId: TENANT, AppId: APP, Environment: ENV, TraceId: traceId,
      SpanId: `${traceId.slice(0, 10)}t${i}`, ParentSpanId: `${traceId.slice(0, 12)}root`,
      SpanName: turn.role === "user" ? "agent.turn.user" : "agent.turn.assistant",
      Type: turn.role === "user" ? "SPAN" : "GENERATION",
      Timestamp: dt64(base + (i + 1) * 1000),
      Input: turn.role === "user" ? turn.text : "",
      Output: turn.role === "assistant" ? turn.text : "",
      CreatedAt: dt(Date.now()), IsDeleted: 0, StatusCode: "STATUS_CODE_OK",
      Duration: 100, Cost: turn.role === "assistant" ? 0.01 : 0,
    });
  });
  await admin.insert({ table: "otel_traces", values: rows, format: "JSONEachRow" });
  await admin.insert({
    table: "agent_session_summary",
    values: [{
      TenantId: TENANT, AppId: APP, TraceId: traceId, SessionId: traceId,
      ParentSessionId: opts.parentSessionId ?? "", Origin: opts.origin ?? "interactive",
      StartedAt: dt64(base).slice(0, 23), UserTurnCount: turns.filter((t) => t.role === "user").length,
    }],
    format: "JSONEachRow",
  });
}

async function steeringRows(traceId: string) {
  const rs = await admin.query({
    query: `SELECT ItemIndex, ExtractorVersion, Summary, Label, length(Embedding) AS dim, Status
            FROM trace_facets FINAL
            WHERE TenantId = {t:String} AND TraceId = {tr:String} AND Facet = 'steering' AND IsDeleted = 0
            ORDER BY ItemIndex`,
    query_params: { t: TENANT, tr: traceId },
    format: "JSONEachRow",
  });
  return rs.json<{ ItemIndex: number; ExtractorVersion: number; Summary: string; Label: string; dim: number; Status: string }>();
}

async function facetKinds(traceId: string) {
  const rs = await admin.query({
    query: `SELECT DISTINCT Facet FROM trace_facets FINAL
            WHERE TenantId = {t:String} AND TraceId = {tr:String} AND IsDeleted = 0 ORDER BY Facet`,
    query_params: { t: TENANT, tr: traceId },
    format: "JSONEachRow",
  });
  return (await rs.json<{ Facet: string }>()).map((r) => r.Facet);
}

function makeService() {
  const store = createTopicsStore({ url: CH_URL, password: CH_PASSWORD });
  const mock = new MockTopicsModelClient();
  const config = resolveTopicsConfig({
    TOPICS_ENRICHMENT_ENABLED: "true",
    TOPICS_MOCK_MODEL: "true",
    TOPICS_TENANT_ALLOWLIST: TENANT,
    TOPICS_DEBOUNCE_MINUTES: "1",
    TOPICS_BATCH_LIMIT: "100",
    TOPICS_LOOKBACK_HOURS: "48",
  });
  return new TopicsEnrichmentService(store, { structured: mock, embedding: mock }, config);
}

describe.skipIf(!RUN)("topics enrichment — real ClickHouse", () => {
  beforeAll(async () => {
    // Fail loudly if the schema predates the fan-out columns.
    const rs = await admin.query({
      query: `SELECT count() AS c FROM system.columns WHERE table = 'trace_facets' AND name = 'ItemIndex'`,
      format: "JSONEachRow",
    });
    const [{ c }] = await rs.json<{ c: string }>();
    if (Number(c) !== 1) throw new Error("trace_facets.ItemIndex missing — migrate local ClickHouse to >= 37");
  });

  it("a multi-correction session fans out one steering row per correction, distinct embeddings", async () => {
    // 1 opening task turn (skipped by the renderer) + 3 distinct corrections.
    await seedSession(TR_MULTI, [
      { role: "user", text: "Add a steering column to the sessions list please." },
      { role: "assistant", text: "Done, I used the legacy client for the fetch." },
      { role: "user", text: "No, use the repo api helper instead of the legacy client for dashboard calls." },
      { role: "assistant", text: "Switched to the repo api helper and pushed the branch." },
      { role: "user", text: "Do not push until the integration tests pass locally every time." },
      { role: "assistant", text: "Understood, holding pushes until tests are green." },
      { role: "user", text: "Always name migrations with the numeric prefix convention we use." },
    ]);

    await makeService().run();

    const steering = await steeringRows(TR_MULTI);
    expect(steering.map((r) => r.ItemIndex)).toEqual([0, 1, 2]);
    expect(steering.every((r) => r.ExtractorVersion === STEERING_EXTRACTOR_VERSION)).toBe(true);
    expect(steering.every((r) => r.Status === "ok" && r.dim === 1024)).toBe(true);
    // Each correction summarizes its OWN turn — distinct text, distinct vectors.
    const summaries = steering.map((r) => r.Summary);
    expect(new Set(summaries).size).toBe(3);
    expect(summaries.some((s) => /legacy|api/i.test(s))).toBe(true);
    expect(summaries.some((s) => /test/i.test(s))).toBe(true);
    expect(summaries.some((s) => /migration|prefix/i.test(s))).toBe(true);
    // All three builtins still written alongside.
    expect(await facetKinds(TR_MULTI)).toEqual(["issues", "sentiment", "steering", "task"]);
  });

  it("a real single-correction session yields exactly one embedded steering summary", async () => {
    await seedSession(TR_SINGLE, [
      { role: "user", text: "Please refactor the auth guard to be permission based." },
      { role: "assistant", text: "Refactored using a role check." },
      { role: "user", text: "Use granular permissions, never a coarse role check, per our convention." },
    ]);
    await makeService().run();
    const steering = await steeringRows(TR_SINGLE);
    expect(steering).toHaveLength(1);
    expect(steering[0]!.ItemIndex).toBe(0);
    expect(steering[0]!.dim).toBe(1024);
    expect(steering[0]!.Label).toBe("");
    expect(steering[0]!.Summary.length).toBeGreaterThan(0);
  });

  it("a NULL-user-text session (the imported-corpus shape) yields task but ZERO steering summaries", async () => {
    // User turns exist structurally but carry empty text — exactly the
    // imported Codex corpus defect. Assistant/tool content present so task
    // still summarizes.
    await seedSession(TR_NULL, [
      { role: "user", text: "" },
      { role: "assistant", text: "Ran exec_command to list the failing package and applied a patch." },
      { role: "user", text: "" },
      { role: "assistant", text: "Executed the build and reported the compile errors found." },
      { role: "user", text: "" },
    ]);
    await makeService().run();

    const kinds = await facetKinds(TR_NULL);
    expect(kinds).toContain("task"); // task survives on assistant/tool content
    // No embedded steering summary exists for a text-less session.
    const steering = await steeringRows(TR_NULL);
    expect(steering.filter((r) => r.dim > 0)).toHaveLength(0);

    // The backfill sweep makes it terminal with a NONE marker (no embedding),
    // so it never re-enters the scan and never counts toward the floor.
    await makeService().runSteeringBackfill();
    const afterSweep = await steeringRows(TR_NULL);
    expect(afterSweep).toHaveLength(1);
    expect(afterSweep[0]!.Label).toBe("NONE");
    expect(afterSweep[0]!.dim).toBe(0);
    expect(afterSweep[0]!.ExtractorVersion).toBe(STEERING_EXTRACTOR_VERSION);
  });

  it("a MONSTER session (hundreds of fat turns) is digested end-to-end — bounded rendering, real rows, ending visible", async () => {
    // An unbounded rendering of a long session blows the model budget and the
    // call hangs, stalling the pipeline. Every trace must be digested — the
    // rendering is bounded head+tail, so the model still sees the ending
    // (where the failure signal lives), proven here by tail vocabulary
    // surfacing in the mock's input-derived summaries.
    const turns: { role: "user" | "assistant"; text: string }[] = [
      { role: "user", text: "Build the warehouse importer for the analytics datasets please." },
    ];
    for (let i = 0; i < 260; i++) {
      // Unique filler vocabulary per turn: no padding token repeats enough
      // to outrank the tail beacon in the mock's frequency-based summaries.
      const filler = Array.from({ length: 110 }, (_, k) => `w${i}x${k}`).join(" ");
      turns.push({ role: "assistant", text: `Progress update ${i}: ${filler}` });
    }
    turns.push({ role: "assistant", text: "catastrophe ".repeat(40) + " the importer deployment crashed with a fatal migration error at the very end." });
    await seedSession(TR_MONSTER, turns);

    await makeService().run();

    const kinds = await facetKinds(TR_MONSTER);
    expect(kinds).toEqual(expect.arrayContaining(["issues", "sentiment", "task"]));
    const rs = await admin.query({
      query: `SELECT Facet, Status, Summary, length(Embedding) AS dim, ExtractorVersion
              FROM trace_facets FINAL
              WHERE TenantId = {t:String} AND TraceId = {tr:String} AND Facet IN ('task','issues') AND IsDeleted = 0
              ORDER BY Facet`,
      query_params: { t: TENANT, tr: TR_MONSTER },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ Facet: string; Status: string; Summary: string; dim: number; ExtractorVersion: number }>();
    expect(rows.map((r) => [r.Facet, r.Status])).toEqual([
      ["issues", "ok"],
      ["task", "ok"],
    ]);
    for (const row of rows) {
      expect(row.dim).toBe(1024);
      expect(row.ExtractorVersion).toBe(2);
    }
    // Tail visibility, proven structurally: the ONLY negative vocabulary
    // ("crashed", "fatal") lives in the session's FINAL turn. The mock emits
    // the NONE sentinel unless negativity is visible in the rendering — so a
    // real prose issues row here means the elided rendering kept the tail.
    const issues = rows.find((r) => r.Facet === "issues")!;
    expect(issues.Summary).toContain("problems related to");
  });
});
