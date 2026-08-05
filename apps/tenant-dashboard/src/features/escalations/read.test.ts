/**
 * The React Server Component (RSC) read helper resolves the per-request ServiceContext and returns the
 * app's actionable escalations through the real service query (MSW-backed) —
 * the seam the benchmarks page calls to seed the queue.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedEnvEscalationMswState,
  type EnvEscalationMswRow,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { loadCtxMock } = vi.hoisted(() => ({ loadCtxMock: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ loadRequestServiceContext: loadCtxMock }));

import { loadEscalationsForApp } from "./read";

const APP_ID = "app-1";

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
  } satisfies ServiceContext);
});

it("resolves the request context and returns the app's actionable set only", async () => {
  seedEnvEscalationMswState({
    rows: [
      row({ id: "e-open", created_at: "2026-07-13T11:00:00.000Z" }),
      row({ id: "e-acked", status: "acked", created_at: "2026-07-13T09:00:00.000Z" }),
      row({ id: "e-resolved", status: "resolved" }),
      row({ id: "e-foreign", app_id: "other-app" }),
    ],
  });

  const rows = await loadEscalationsForApp(APP_ID);

  expect(loadCtxMock).toHaveBeenCalledTimes(1);
  // Newest-first, open + acked only — resolved and foreign-app rows excluded.
  expect(rows.map((r) => r.id)).toEqual(["e-open", "e-acked"]);
});
