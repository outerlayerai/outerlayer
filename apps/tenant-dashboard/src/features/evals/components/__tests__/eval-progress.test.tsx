// @vitest-environment jsdom
/**
 * Component test for the live trial matrix. Renders a mixed
 * fixture across every cell state and asserts the progress count, cost-vs-budget
 * meter, resolved count, per-config columns, and the status legend all render.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { EvalProgress } from "../eval-progress";
import type { TrialCell } from "../fake-runner";

const cell = (configId: string, taskId: string, trialIndex: number, status: TrialCell["status"], resolved = false): TrialCell => ({
  taskId,
  configId,
  trialIndex,
  status,
  resolved,
});

const cells: TrialCell[] = [
  cell("opus", "t1", 0, "graded", true),
  cell("opus", "t1", 1, "running"),
  cell("opus", "t2", 0, "queued"),
  cell("glm", "t1", 0, "agent_error"),
  cell("glm", "t2", 0, "timeout"),
  cell("glm", "t2", 1, "graded", false),
];

describe("EvalProgress", () => {
  it("renders progress, cost vs budget, resolved count, both configs, and the legend", () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <EvalProgress cells={cells} configs={["opus", "glm"]} budgetUsd={90} spentUsd={12.5} />
      </ThemeProvider>,
    );
    const panel = screen.getByTestId("eval-progress");
    // 4 of 6 cells are terminal (not queued/running); exactly 1 graded-and-resolved.
    expect(panel).toHaveTextContent(/4\/6 trials/);
    expect(panel).toHaveTextContent(/\$12\.50 \/ \$90/);
    expect(panel).toHaveTextContent(/1 resolved/);
    // both config columns are labelled
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("glm")).toBeInTheDocument();
    // the status legend enumerates every cell state
    for (const status of ["graded", "running", "agent_error", "timeout"]) {
      expect(screen.getByText(status)).toBeInTheDocument();
    }
  });
});
