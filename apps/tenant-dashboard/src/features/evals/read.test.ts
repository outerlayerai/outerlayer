/**
 * The React Server Component (RSC) read helper resolves the per-request ServiceContext and returns the
 * app's run history through the real service query (MSW-backed) — the seam
 * the benchmarks page calls to seed the history table.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedEvalRunMswState, type EvalRunMswRow } from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { loadCtxMock } = vi.hoisted(() => ({ loadCtxMock: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ loadRequestServiceContext: loadCtxMock }));

import { loadEvalRunsForApp } from "./read";

const APP_ID = "app-1";

function row(overrides: Partial<EvalRunMswRow> & { id: string }): EvalRunMswRow {
  return {
    tenant_id: "tenant-1",
    app_id: APP_ID,
    environment_id: "env-1",
    status: "succeeded",
    repo_label: "acme/x",
    request: { configs: [] },
    card: { verdict: "clear" },
    cost_usd: 1.5,
    error: null,
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

it("resolves the request context and returns the app's runs newest-first, capped at the limit", async () => {
  seedEvalRunMswState({
    rows: [
      row({ id: "old", created_at: "2026-07-13T09:00:00.000Z" }),
      row({ id: "new", created_at: "2026-07-13T11:00:00.000Z" }),
      row({ id: "foreign", app_id: "other-app", created_at: "2026-07-13T12:00:00.000Z" }),
    ],
  });

  const runs = await loadEvalRunsForApp(APP_ID, 2);

  expect(loadCtxMock).toHaveBeenCalledTimes(1);
  expect(runs.map((r) => r.id)).toEqual(["new", "old"]);
});
