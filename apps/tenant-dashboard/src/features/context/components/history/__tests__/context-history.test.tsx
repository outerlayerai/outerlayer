// @vitest-environment jsdom
/**
 * Component tests for the Context › History panel (`<ContextHistory>`).
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md):
 *  - `context_sync_event` reads go through the context read action (server
 *    seam) → vi.mock; the real SWR hook runs and unwraps the result envelope,
 *    same pattern as the skill/MCP drill-down panes.
 *  - The realtime WebSocket is the accepted non-action seam: `context-sync-realtime`
 *    is this section's OWN module, mocked to a probe that captures the refetch
 *    callback and the per-mount channel topic.
 */
import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ContextSyncEventRow } from "../../../types";

// Render with the real i18n + en.json so the column/empty/error copy assertions
// prove the translation keys resolve to the shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

// The sync-history read action, over mutable state so each test picks its
// ledger rows (or a failed envelope); the mock applies the same app_id
// scoping, DESC ordering, and page slicing the real service performs.
const { historyState } = vi.hoisted(() => ({
  historyState: {
    rows: [] as ContextSyncEventRow[],
    fail: false,
  },
}));
vi.mock("@/features/context/read-actions", () => ({
  getContextSyncHistory: vi.fn(
    async ({ appId, page, pageSize }: { appId: string; page: number; pageSize: number }) => {
      if (historyState.fail) return { ok: false, error: { message: "boom" } };
      const scoped = historyState.rows.filter((r) => r.app_id === appId);
      const sorted = [...scoped].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      );
      const from = page * pageSize;
      return { ok: true, data: { rows: sorted.slice(from, from + pageSize), total: sorted.length } };
    },
  ),
}));

// Realtime seam probe — capture the refetch callback + the topics requested.
let capturedOnChange: (() => void) | undefined;
const receivedTopics: string[] = [];
vi.mock("../context-sync-realtime", () => ({
  subscribeContextSyncEvents: ({ topic, onChange }: { topic: string; onChange: () => void }) => {
    receivedTopics.push(topic);
    capturedOnChange = onChange;
    return () => {};
  },
}));

import { ContextHistory } from "../context-history";

function makeRow(overrides: Partial<ContextSyncEventRow> = {}): ContextSyncEventRow {
  return {
    id: "evt-1",
    app_id: "app-1",
    tenant_id: "tenant-1",
    branch: "main",
    commit_sha: "abcdef1234567890",
    commit_message: "Add deploy skill",
    trigger: "push",
    status: "synced",
    error: null,
    duration_ms: 1500,
    snapshot_id: "snap-1",
    created_at: "2026-07-13T10:00:00.000Z",
    ...overrides,
  };
}

function seed(rows: ContextSyncEventRow[]) {
  historyState.rows = rows;
  historyState.fail = false;
}

// Each test gets its own SWR cache — the hook keys on ["context-sync-history",
// appId, page, pageSize], so a shared module-level cache would serve one
// test's cached page/total to the next.
function renderHistory(children: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>);
}

beforeEach(() => {
  capturedOnChange = undefined;
  receivedTopics.length = 0;
  historyState.rows = [];
  historyState.fail = false;
});

describe("<ContextHistory>", () => {
  // The DESC ordering itself is the mocked action's own sort (see the
  // `getContextSyncHistory` mock above), not the query under test — that
  // ordering is pinned against the real service in service.test.ts. This
  // proves only that the component renders rows in the order the action hook
  // resolves them, not reordering them itself.
  it("renders rows in the order the action resolves them", async () => {
    seed([
      makeRow({ id: "old", created_at: "2026-07-13T08:00:00.000Z", commit_message: "oldest" }),
      makeRow({ id: "new", created_at: "2026-07-13T12:00:00.000Z", commit_message: "newest" }),
      makeRow({ id: "mid", created_at: "2026-07-13T10:00:00.000Z", commit_message: "middle" }),
    ]);
    renderHistory(<ContextHistory appId="app-1" />);

    const items = await screen.findAllByRole("listitem");
    const texts = items.map((li) => li.textContent);
    expect(texts[0]).toContain("newest");
    expect(texts[1]).toContain("middle");
    expect(texts[2]).toContain("oldest");
  });

  // The app_id scoping itself happens in the mock (it filters by the appId
  // argument the hook passed through) — pinned against the real query in
  // service.test.ts. This proves only that an empty action result renders
  // the empty state.
  it("passes appId through to the action and renders the empty state when it resolves no rows", async () => {
    seed([makeRow({ id: "other", app_id: "app-2", commit_message: "not mine" })]);
    renderHistory(<ContextHistory appId="app-1" />);

    expect(
      await screen.findByText(
        "No syncs yet. Push to the connected branch or resync to get started.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("not mine")).not.toBeInTheDocument();
  });

  it("a failed row expands to reveal its full error text", async () => {
    seed([
      makeRow({
        id: "boom",
        status: "failed",
        commit_message: "broken push",
        error: "fatal: could not resolve HEAD",
      }),
    ]);
    renderHistory(<ContextHistory appId="app-1" />);

    await screen.findByText("broken push");
    // Collapsed by default (unmountOnExit) — the error is not in the DOM yet.
    expect(screen.queryByTestId("sync-history-error")).not.toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "Show error" }).click());

    expect(await screen.findByTestId("sync-history-error")).toHaveTextContent(
      "fatal: could not resolve HEAD",
    );
  });

  it("a realtime INSERT appears without a manual refresh (revalidate on the seam callback)", async () => {
    seed([makeRow({ id: "first", created_at: "2026-07-13T10:00:00.000Z", commit_message: "first push" })]);
    renderHistory(<ContextHistory appId="app-1" />);
    await screen.findByText("first push");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    // A new event lands in the ledger and the realtime channel fires INSERT.
    seed([
      makeRow({ id: "second", created_at: "2026-07-13T11:00:00.000Z", commit_message: "second push" }),
      makeRow({ id: "first", created_at: "2026-07-13T10:00:00.000Z", commit_message: "first push" }),
    ]);
    await act(async () => {
      capturedOnChange?.();
    });

    expect(await screen.findByText("second push")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  });

  it("shows an error alert when the ledger read fails", async () => {
    historyState.fail = true;
    renderHistory(<ContextHistory appId="app-1" />);
    expect(await screen.findByText(/could not load sync history/i)).toBeInTheDocument();
  });

  // The `.slice(from, from + pageSize)` itself happens in the mock, given the
  // page/pageSize the hook passed — the real `.range(...)` bounds are pinned
  // in service.test.ts. This proves only that the pager wires page/pageSize
  // state into the action call and renders whatever slice + total comes back.
  it("wires the pager's page/pageSize into the action call and renders its slice + total", async () => {
    // 25 events, evt-01 oldest … evt-25 newest (minute-spaced so DESC is total).
    seed(
      Array.from({ length: 25 }, (_, i) =>
        makeRow({
          id: `evt-${String(i + 1).padStart(2, "0")}`,
          commit_message: `commit ${i + 1}`,
          created_at: `2026-07-13T10:${String(i).padStart(2, "0")}:00.000Z`,
        }),
      ),
    );
    renderHistory(<ContextHistory appId="app-1" />);

    // Page 1: newest 20 (25 … 6), exact total in the pager label.
    await screen.findByText("commit 25");
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText("1–20 of 25")).toBeInTheDocument();
    expect(screen.queryByText("commit 5")).not.toBeInTheDocument();

    act(() => screen.getByRole("button", { name: /next page/i }).click());

    // Page 2: the remaining 5 oldest (5 … 1).
    await screen.findByText("commit 5");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(5));
    expect(screen.getByText("21–25 of 25")).toBeInTheDocument();
    expect(screen.queryByText("commit 25")).not.toBeInTheDocument();
  });

  it("subscribes each mount on a UNIQUE, non-fixed realtime topic (realtime-js dedup guard)", async () => {
    seed([makeRow()]);
    renderHistory(
      <>
        <ContextHistory appId="app-1" />
        <ContextHistory appId="app-1" />
      </>,
    );
    await waitFor(() => expect(receivedTopics.length).toBe(2));
    expect(receivedTopics.every((t) => t.startsWith("context-sync-"))).toBe(true);
    expect(new Set(receivedTopics).size).toBe(2);
  });
});
