// @vitest-environment jsdom
/**
 * Component test for the run wizard. Steps through all four
 * steps and asserts the emitted EvalRunRequest carries the fixed linked repo,
 * the default task set / configs / trials / budget / scenario, and that running
 * closes the dialog. Also covers the closed state and Back navigation.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { EvalWizard } from "../eval-wizard";
import type { EvalRunRequest } from "../fake-runner";

function renderWizard(open = true) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  render(
    <ThemeProvider theme={createTheme()}>
      <EvalWizard open={open} onClose={onClose} onRun={onRun} repoLabel="acme/payments" />
    </ThemeProvider>,
  );
  return { onRun, onClose };
}

describe("EvalWizard", () => {
  it("renders nothing when closed", () => {
    renderWizard(false);
    expect(screen.queryByTestId("eval-wizard")).not.toBeInTheDocument();
  });

  it("steps through all four steps and emits the run request, then closes", async () => {
    const user = userEvent.setup();
    const { onRun, onClose } = renderWizard();

    // Step 0 — the linked repo is fixed context and the MDE is shown live.
    expect(screen.getByTestId("wizard-repo")).toHaveTextContent("acme/payments");
    expect(screen.getByTestId("live-mde")).toHaveTextContent(/detect differences ≥ \d+pp/);

    await user.click(screen.getByTestId("wizard-next")); // → Configs
    await user.click(screen.getByTestId("wizard-next")); // → Trials & budget
    await user.click(screen.getByTestId("wizard-next")); // → Confirm
    await user.click(screen.getByTestId("wizard-run")); // Run evaluation

    expect(onRun).toHaveBeenCalledTimes(1);
    const req = onRun.mock.calls[0]![0] as EvalRunRequest;
    expect(req.repoLabel).toBe("acme/payments");
    expect(req.taskIds).toHaveLength(84);
    expect(req.configs.map((c) => c.id)).toEqual(["opus-4.8", "glm-5.2"]);
    expect(req.trialsPerTask).toBe(3);
    expect(req.budgetUsd).toBe(90);
    expect(req.scenario).toBe("directional");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Back returns to the previous step", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByTestId("wizard-next")); // → Configs
    await user.click(screen.getByRole("button", { name: "Back" })); // → Tasks
    expect(screen.getByTestId("wizard-repo")).toBeInTheDocument();
  });
});
