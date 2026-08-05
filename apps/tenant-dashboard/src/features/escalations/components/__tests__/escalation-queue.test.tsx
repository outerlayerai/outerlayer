// @vitest-environment jsdom
/**
 * Component tests for the env-escalation queue.
 *
 * `EscalationQueueView` is pure presentation over seeded rows — it renders the
 * ticket, self-hides when empty, and reports ack/resolve intents through
 * `onTransition`. The `EscalationQueue` container drives that intent through
 * the server action (mocked here) and surfaces a failed transition inline.
 * The real read/write behavior is proven end-to-end in the integration
 * acceptance suite; these assert the presentation + wiring contract.
 */

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { EscalationQueueView, EscalationQueue } from "../escalation-queue";
import type { EnvEscalationRow } from "../../types";

const { transitionMock } = vi.hoisted(() => ({ transitionMock: vi.fn() }));
vi.mock("../../actions", () => ({ transitionEscalation: transitionMock }));

const APP_ID = "11111111-1111-1111-1111-111111111111";

function escalation(overrides: Partial<EnvEscalationRow> & { id: string }): EnvEscalationRow {
  return {
    app_id: APP_ID,
    eval_run_id: "run-1",
    repo: "acme/payments-api",
    base_commit: "c0ffee",
    task_ids: ["t-1", "t-2"],
    last_errors: [{ stage: "deps", excerpt: "ERROR: no matching distribution for torch==1.4" }],
    attempts: 4,
    cost_usd: 2.5,
    suggested_next_steps: "Pin torch to a py312-compatible version.",
    status: "open",
    created_at: "2026-07-13T10:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

function renderView(props: Parameters<typeof EscalationQueueView>[0]) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <EscalationQueueView {...props} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  transitionMock.mockReset();
  transitionMock.mockResolvedValue({ ok: true, data: {} });
});

describe("EscalationQueueView", () => {
  /* Rows are seeded by the page React Server Component (RSC), so a timestamp formatted during SSR would
   * hydrate into a mismatch for any visitor whose timezone differs from the
   * server's. The ticket renders server-side; only its date waits for mount. */
  it("keeps the created-at timestamp out of the server render", () => {
    const html = renderToString(
      <ThemeProvider theme={createTheme()}>
        <EscalationQueueView escalations={[escalation({ id: "e-1" })]} onTransition={() => {}} />
      </ThemeProvider>,
    );

    expect(html).toContain("acme/payments-api");
    expect(html).not.toMatch(/Jul|July|2026|10:00/);
  });

  it("renders nothing at all while the actionable set is empty and there is no error", () => {
    const { container } = renderView({ escalations: [], onTransition: vi.fn(), error: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a ticket: repo, attempts/cost line, error excerpt + suggested next step on expand", async () => {
    renderView({ escalations: [escalation({ id: "e-1" })], onTransition: vi.fn() });

    const item = screen.getByTestId("escalation-e-1");
    expect(item).toHaveTextContent("acme/payments-api");
    expect(item).toHaveTextContent("4 attempts");
    expect(item).toHaveTextContent("$2.50 spent");
    expect(screen.getByTestId("escalation-status-e-1")).toHaveTextContent("open");

    await userEvent.click(screen.getByRole("button", { name: "Expand details" }));
    expect(item).toHaveTextContent("ERROR: no matching distribution for torch==1.4");
    expect(item).toHaveTextContent("Pin torch to a py312-compatible version.");
  });

  it("Acknowledge reports {acked} for the row; an open row also offers Resolve", async () => {
    const onTransition = vi.fn();
    renderView({ escalations: [escalation({ id: "e-1" })], onTransition });

    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(onTransition).toHaveBeenCalledWith("e-1", "acked");

    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onTransition).toHaveBeenCalledWith("e-1", "resolved");
  });

  it("an acked row offers Resolve but no Acknowledge", async () => {
    const onTransition = vi.fn();
    renderView({ escalations: [escalation({ id: "e-1", status: "acked" })], onTransition });

    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onTransition).toHaveBeenCalledWith("e-1", "resolved");
  });

  it("shows an error banner and keeps the ticket visible when a transition fails", () => {
    renderView({
      escalations: [escalation({ id: "e-1" })],
      onTransition: vi.fn(),
      error: "cannot move an escalation",
    });
    expect(screen.getByText("cannot move an escalation")).toBeInTheDocument();
    expect(screen.getByTestId("escalation-e-1")).toBeInTheDocument();
  });
});

describe("EscalationQueue container", () => {
  function renderContainer(initial: EnvEscalationRow[]) {
    return render(
      <ThemeProvider theme={createTheme()}>
        <EscalationQueue appId={APP_ID} initialEscalations={initial} />
      </ThemeProvider>,
    );
  }

  it("drives the ack through the server action with the app + row + status", async () => {
    renderContainer([escalation({ id: "e-1" })]);

    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(transitionMock).toHaveBeenCalledWith({
      appId: APP_ID,
      escalationId: "e-1",
      status: "acked",
    });
  });

  it("surfaces a failed server-side read instead of self-hiding on it", () => {
    // The view hides itself when there is nothing actionable, so a swallowed
    // read failure renders as an environment with no blocked builds.
    render(
      <ThemeProvider theme={createTheme()}>
        <EscalationQueue appId={APP_ID} initialEscalations={[]} readError="Couldn't load them." />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("escalation-queue")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load them.")).toBeInTheDocument();
  });

  it("tracks the server's answer across re-renders instead of freezing the first one", () => {
    // The read error is the server's CURRENT answer, so a refresh has to be
    // able to clear it and to raise a new one. Seeded into state it would do
    // neither: the queue would keep showing a failure that has since recovered.
    const { rerender } = render(
      <ThemeProvider theme={createTheme()}>
        <EscalationQueue appId={APP_ID} initialEscalations={[]} readError="Couldn't load them." />
      </ThemeProvider>,
    );
    expect(screen.getByText("Couldn't load them.")).toBeInTheDocument();

    rerender(
      <ThemeProvider theme={createTheme()}>
        <EscalationQueue
          appId={APP_ID}
          initialEscalations={[escalation({ id: "e-1" })]}
          readError={null}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByText("Couldn't load them.")).not.toBeInTheDocument();
    expect(screen.getByTestId("escalation-e-1")).toBeInTheDocument();
  });

  it("surfaces a failed transition inline instead of silently dropping it", async () => {
    transitionMock.mockResolvedValue({ ok: false, error: { code: "internal_error", message: "cannot move an escalation" } });
    renderContainer([escalation({ id: "e-1", status: "acked" })]);

    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("cannot move an escalation")).toBeInTheDocument();
    expect(screen.getByTestId("escalation-e-1")).toBeInTheDocument();
  });
});
