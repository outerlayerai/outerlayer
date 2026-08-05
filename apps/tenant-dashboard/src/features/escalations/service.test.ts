/**
 * EnvEscalationService — the read + lifecycle rules, exercised through the real
 * PostgREST query path against the MSW `env_escalation` table (no query-chain
 * mocks). The service takes a per-request `ctx`; the client comes in as
 * `ctx.db`, so these assert the query shape and the state machine, the same
 * ground the deleted route test covered but at the service seam.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedEnvEscalationMswState,
  getEnvEscalationMswState,
  type EnvEscalationMswRow,
} from "@/test-helpers/msw-handlers";

import { escalationsService, EnvEscalationTransitionError } from "./service";

const APP_ID = "app-1";
const ACTOR = { userId: "user-1", role: "owner" };

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: "tenant-1", actor: ACTOR };
}

function row(overrides: Partial<EnvEscalationMswRow> & { id: string }): EnvEscalationMswRow {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    eval_run_id: null,
    repo: "acme/api",
    base_commit: "c0ffee",
    task_ids: ["t-1"],
    last_errors: [{ stage: "deps", excerpt: "pip install failed", setup: "pip install -e ." }],
    attempts: 3,
    cost_usd: 1.25,
    suggested_next_steps: "Pin the numpy version.",
    status: "open",
    created_at: "2026-07-13T10:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

describe("EnvEscalationService.list", () => {
  it("returns the actionable set (open + acked) newest-first — resolved and foreign-app rows excluded", async () => {
    seedEnvEscalationMswState({
      rows: [
        row({ id: "e-old-open", created_at: "2026-07-12T10:00:00.000Z" }),
        row({ id: "e-acked", status: "acked", created_at: "2026-07-13T09:00:00.000Z" }),
        row({ id: "e-new-open", created_at: "2026-07-13T11:00:00.000Z" }),
        row({ id: "e-resolved", status: "resolved" }),
        row({ id: "e-foreign", app_id: "other-app" }),
      ],
    });

    const rows = await escalationsService.list(ctx(), APP_ID);
    expect(rows.map((r) => r.id)).toEqual(["e-new-open", "e-acked", "e-old-open"]);
  });

  it("narrows to explicit statuses when asked for history", async () => {
    seedEnvEscalationMswState({
      rows: [row({ id: "e-open" }), row({ id: "e-resolved", status: "resolved" })],
    });

    const rows = await escalationsService.list(ctx(), APP_ID, ["resolved"]);
    expect(rows.map((r) => r.id)).toEqual(["e-resolved"]);
  });
});

describe("EnvEscalationService.transition", () => {
  it("acks an open escalation: persists status + stamps the actor, returns the row", async () => {
    seedEnvEscalationMswState({ rows: [row({ id: "e-1" })] });

    const updated = await escalationsService.transition(ctx(), {
      appId: APP_ID,
      escalationId: "e-1",
      status: "acked",
    });
    expect(updated?.id).toBe("e-1");
    expect(updated?.status).toBe("acked");

    const persisted = getEnvEscalationMswState().find((r) => r.id === "e-1")!;
    expect(persisted.status).toBe("acked");
    expect(persisted.updated_by).toBe("user-1");
    expect(typeof persisted.updated_at).toBe("string");
  });

  it("resolves an acked escalation", async () => {
    seedEnvEscalationMswState({ rows: [row({ id: "e-1", status: "acked" })] });

    const updated = await escalationsService.transition(ctx(), {
      appId: APP_ID,
      escalationId: "e-1",
      status: "resolved",
    });
    expect(updated?.status).toBe("resolved");
    expect(getEnvEscalationMswState()[0]!.status).toBe("resolved");
  });

  it("refuses an illegal move (resolved is terminal) and writes nothing", async () => {
    seedEnvEscalationMswState({ rows: [row({ id: "e-1", status: "resolved" })] });

    await expect(
      escalationsService.transition(ctx(), { appId: APP_ID, escalationId: "e-1", status: "acked" }),
    ).rejects.toBeInstanceOf(EnvEscalationTransitionError);
    expect(getEnvEscalationMswState()[0]!.status).toBe("resolved");
  });

  it("returns null for a row RLS can't see — unknown id and foreign tenant are indistinguishable", async () => {
    seedEnvEscalationMswState({ rows: [row({ id: "e-foreign", app_id: "other-app" })] });

    const updated = await escalationsService.transition(ctx(), {
      appId: APP_ID,
      escalationId: "e-foreign",
      status: "acked",
    });
    expect(updated).toBeNull();
    // The foreign-app row is untouched.
    expect(getEnvEscalationMswState()[0]!.status).toBe("open");
  });
});
