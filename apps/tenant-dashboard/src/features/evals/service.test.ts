/**
 * EvalRunService — persistence + lifecycle, exercised through the real PostgREST
 * query path against the MSW `eval_run` table (no query-chain mocks). The
 * service takes a per-request `ctx`; the client arrives as `ctx.db`, so these
 * assert the query shape (including the list projection) and the write payloads.
 */

import { http, HttpResponse } from "msw";

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { server } from "@/test-helpers/msw-server";
import {
  seedEvalRunMswState,
  getEvalRunMswState,
  type EvalRunMswRow,
} from "@/test-helpers/msw-handlers";

import { evalsService } from "./service";

const APP_ID = "app-1";
const ENV_ID = "env-1";
const TENANT_ID = "tenant-1";
const ACTOR = { userId: "user-1", role: "owner" };

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: TENANT_ID, actor: ACTOR };
}

function row(overrides: Partial<EvalRunMswRow> & { id: string }): EvalRunMswRow {
  return {
    tenant_id: TENANT_ID,
    app_id: APP_ID,
    environment_id: ENV_ID,
    status: "running",
    repo_label: "acme/x",
    request: { configs: [] },
    card: null,
    cost_usd: 0,
    error: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

describe("EvalRunService.create", () => {
  it("persists a queued run scoped to the app + tenant, stamping the actor, and returns it with an id", async () => {
    const run = await evalsService.create(ctx(), {
      appId: APP_ID,
      environmentId: ENV_ID,
      repoLabel: "acme/payments",
      request: { configs: [{ id: "a", launcher: "claude-code", model: "m" }], taskCount: 5 },
    });

    expect(run.status).toBe("queued");
    const stored = getEvalRunMswState();
    expect(stored).toHaveLength(1);
    // The returned run carries the persisted row's generated id.
    expect(run.id).toEqual(stored[0]!.id);
    // tenant_id/created_by come from ctx, never a positional caller argument.
    expect(stored[0]).toMatchObject({
      app_id: APP_ID,
      tenant_id: TENANT_ID,
      created_by: "user-1",
      environment_id: ENV_ID,
      repo_label: "acme/payments",
      status: "queued",
    });
  });
});

describe("EvalRunService.get", () => {
  it("returns the full single row including the card, and null when RLS can't see it", async () => {
    seedEvalRunMswState({
      rows: [row({ id: "r1", status: "succeeded", card: { verdict: "clear" }, cost_usd: 1.5 })],
    });

    const found = await evalsService.get(ctx(), APP_ID, "r1");
    expect(found?.status).toBe("succeeded");
    expect(found?.card).toEqual({ verdict: "clear" });

    expect(await evalsService.get(ctx(), APP_ID, "nope")).toBeNull();
  });
});

describe("EvalRunService.list", () => {
  it("returns runs newest-first, capped by the limit, for the app only", async () => {
    seedEvalRunMswState({
      rows: [
        row({ id: "old", created_at: "2026-07-01T00:00:00.000Z" }),
        row({ id: "new", created_at: "2026-07-05T00:00:00.000Z" }),
        row({ id: "foreign", app_id: "other-app", created_at: "2026-07-09T00:00:00.000Z" }),
      ],
    });

    const runs = await evalsService.list(ctx(), APP_ID, 1);
    expect(runs.map((r) => r.id)).toEqual(["new"]);
  });

  it("projects the summary columns only — the heavy card blob is never selected per row", async () => {
    let capturedSelect: string | null = null;
    server.use(
      http.get("http://localhost:54321/rest/v1/eval_run", ({ request }) => {
        capturedSelect = new URL(request.url).searchParams.get("select");
        return HttpResponse.json([]);
      }),
    );

    await evalsService.list(ctx(), APP_ID);

    expect(capturedSelect).not.toBeNull();
    for (const column of ["id", "status", "repo_label", "request", "cost_usd", "error", "created_at"]) {
      expect(capturedSelect).toContain(column);
    }
    // The card (and audit columns) are fetched on open, never shipped per row.
    expect(capturedSelect).not.toContain("card");
  });
});

describe("EvalRunService lifecycle write-backs", () => {
  it("markRunning flips a queued run to running", async () => {
    seedEvalRunMswState({ rows: [row({ id: "r1", status: "queued" })] });
    await evalsService.markRunning(ctx(), APP_ID, "r1");
    expect(getEvalRunMswState().find((r) => r.id === "r1")?.status).toBe("running");
  });

  it("complete writes the Report Card + cost and flips status to succeeded", async () => {
    seedEvalRunMswState({ rows: [row({ id: "r1", status: "running" })] });
    await evalsService.complete(ctx(), APP_ID, "r1", { verdict: "clear" }, 1.23);
    const stored = getEvalRunMswState().find((r) => r.id === "r1");
    expect(stored?.status).toBe("succeeded");
    expect(stored?.card).toEqual({ verdict: "clear" });
    expect(stored?.cost_usd).toBe(1.23);
  });

  it("fail records the (bounded) error and flips status to failed", async () => {
    seedEvalRunMswState({ rows: [row({ id: "r1", status: "running" })] });
    await evalsService.fail(ctx(), APP_ID, "r1", "infra_error: docker unavailable");
    const stored = getEvalRunMswState().find((r) => r.id === "r1");
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("docker unavailable");
  });

  it("fail truncates a runaway backend error to exactly 2000 characters", async () => {
    seedEvalRunMswState({ rows: [row({ id: "r1", status: "running" })] });
    const message = "x".repeat(2500);
    await evalsService.fail(ctx(), APP_ID, "r1", message);
    const stored = getEvalRunMswState().find((r) => r.id === "r1");
    expect(stored?.error).toHaveLength(2000);
    expect(stored?.error).toBe(message.slice(0, 2000));
  });
});
