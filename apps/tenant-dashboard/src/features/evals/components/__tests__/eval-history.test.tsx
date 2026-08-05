// @vitest-environment jsdom
/**
 * Persisted run history is pure presentation over the run list seeded by a
 * React Server Component (RSC), so
 * the contract worth pinning is its timestamp column: the run's `created_at`
 * is seeded server-side, and a date formatted during SSR would hydrate into a
 * mismatch for any visitor whose timezone differs from the server's.
 */
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { ThemeProvider, createTheme } from "@mui/material/styles";

import { EvalRunHistory } from "../eval-history";
import type { EvalRunSummary } from "../real-runner";

const RUN: EvalRunSummary = {
  id: "run-1",
  status: "succeeded",
  repo_label: "acme/payments-api",
  request: { configs: [{ id: "baseline" }, { id: "candidate" }], taskCount: 12, trialsPerTask: 3 },
  card: null,
  cost_usd: 4.25,
  error: null,
  created_at: "2026-07-30T14:45:07Z",
};

const withTheme = (node: React.ReactNode) => (
  <ThemeProvider theme={createTheme()}>{node}</ThemeProvider>
);

describe("EvalRunHistory", () => {
  it("keeps every timestamp out of the server render", () => {
    const html = renderToString(withTheme(<EvalRunHistory runs={[RUN]} onOpen={() => {}} />));

    // The row itself is server-rendered; only its date waits for the client.
    expect(html).toContain("baseline vs candidate");
    expect(html).not.toMatch(/Jul|July|2026|14:45|2:45/);
  });

  it("renders the run timestamp once mounted", () => {
    render(withTheme(<EvalRunHistory runs={[RUN]} onOpen={() => {}} />));

    // Formatted in the runner's own zone, so assert the parts that hold
    // whatever that zone is rather than a fixed clock reading.
    expect(screen.getByText(/7\/30\/2026|7\/29\/2026|7\/31\/2026/)).toBeInTheDocument();
  });

  it("renders the row's other columns from the seeded run", () => {
    render(withTheme(<EvalRunHistory runs={[RUN]} onOpen={() => {}} />));

    expect(screen.getByText("baseline vs candidate")).toBeInTheDocument();
    expect(screen.getByText("12 × 3")).toBeInTheDocument();
    expect(screen.getByText("$4.25")).toBeInTheDocument();
  });
});
