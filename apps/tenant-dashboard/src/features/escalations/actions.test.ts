/**
 * The ack/resolve server action — the glue around `authorizedAction`: it
 * authorizes on env_escalation.update, maps the service's null (invisible row)
 * to a `kind: "not_found"` outcome and an illegal move to a thrown error's
 * message, and re-seeds the benchmarks React Server Component (RSC) via revalidatePath only on a real
 * transition. The context + permission seams are mocked; the transition runs
 * for real against the MSW table.
 */

import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedEnvEscalationMswState,
  getEnvEscalationMswState,
  type EnvEscalationMswRow,
} from "@/test-helpers/msw-handlers";

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { transitionEscalation } from "./actions";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const ESC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const BENCHMARKS_PATH = "/orgs/[orgName]/apps/[appName]/env/[envName]/benchmarks";

function row(overrides: Partial<EnvEscalationMswRow> & { id: string }): EnvEscalationMswRow {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    eval_run_id: null,
    repo: "acme/api",
    base_commit: "c0ffee",
    task_ids: ["t-1"],
    last_errors: [],
    attempts: 1,
    cost_usd: 0.5,
    suggested_next_steps: "Pin numpy.",
    status: "open",
    created_at: "2026-07-13T10:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

it("acks a visible row: authorizes on env_escalation.update, returns the row, revalidates", async () => {
  seedEnvEscalationMswState({ rows: [row({ id: ESC_ID, status: "open" })] });

  const res = await transitionEscalation({ appId: APP_ID, escalationId: ESC_ID, status: "acked" });

  expect(res).toMatchObject({ ok: true, data: { kind: "ok", escalation: { id: ESC_ID, status: "acked" } } });
  expect(checkPermMock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user-1" }),
    "env_escalation.update",
    APP_ID,
  );
  expect(revalidateMock).toHaveBeenCalledWith(BENCHMARKS_PATH, "page");
  expect(getEnvEscalationMswState()[0]!.status).toBe("acked");
});

it("denies an actor lacking env_escalation.update, writing nothing and not revalidating", async () => {
  checkPermMock.mockResolvedValue(false);
  seedEnvEscalationMswState({ rows: [row({ id: ESC_ID, status: "open" })] });

  const res = await transitionEscalation({ appId: APP_ID, escalationId: ESC_ID, status: "acked" });

  expect(res).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringMatching(/Permission denied/) } });
  expect(revalidateMock).not.toHaveBeenCalled();
  expect(getEnvEscalationMswState()[0]!.status).toBe("open");
});

it("maps an invisible row to a not-found outcome without revalidating", async () => {
  // A row in another app is invisible to this appId's query → service returns null.
  seedEnvEscalationMswState({ rows: [row({ id: ESC_ID, app_id: "other-app", status: "open" })] });

  const res = await transitionEscalation({ appId: APP_ID, escalationId: ESC_ID, status: "acked" });

  expect(res).toEqual({ ok: true, data: { kind: "not_found" } });
  expect(revalidateMock).not.toHaveBeenCalled();
});

it("surfaces an illegal transition as its message without revalidating", async () => {
  seedEnvEscalationMswState({ rows: [row({ id: ESC_ID, status: "resolved" })] });

  const res = await transitionEscalation({ appId: APP_ID, escalationId: ESC_ID, status: "acked" });

  expect(res).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cannot move an escalation/) } });
  expect(revalidateMock).not.toHaveBeenCalled();
  expect(getEnvEscalationMswState()[0]!.status).toBe("resolved");
});
