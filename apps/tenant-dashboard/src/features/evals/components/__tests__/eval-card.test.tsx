// @vitest-environment jsdom
/**
 * Component tests for the Evals Report Card.
 *
 * The central assertion is the integrity guarantee: a card NEVER shows a
 * winner without its verdict tier AND the MDE line.
 * These render the real card component from the seeded fake runner across all
 * three verdict tiers and assert the chip + MDE line are always present.
 */

vi.mock("@mui/x-data-grid", () => ({}));

import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import type { Verdict } from "@outerlayer/report-card";
import { EvalCard } from "../eval-card";
import { buildCardFromCells, planTrialCells, resolveCell, type EvalRunRequest } from "../fake-runner";

function cardFor(scenario: Verdict) {
  const request: EvalRunRequest = {
    repoLabel: "acme/payments-api",
    taskIds: Array.from({ length: 84 }, (_v, i) => `task-${i}`),
    configs: [
      { id: "opus-4.8", launcher: "claude-code", model: "claude-opus-4-8" },
      { id: "glm-5.2", launcher: "claude-code", model: "glm-5.2" },
    ],
    trialsPerTask: 3,
    budgetUsd: 90,
    scenario,
  };
  const cells = planTrialCells(request).map((c) => resolveCell(request, c));
  return buildCardFromCells(request, cells);
}

function renderCard(scenario: Verdict) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <EvalCard card={cardFor(scenario)} />
    </ThemeProvider>,
  );
}

describe("EvalCard integrity (never a naked winner)", () => {
  const tiers: [Verdict, string][] = [
    ["clear", "Clear result"],
    ["directional", "Directional"],
    ["underpowered", "Underpowered"],
  ];

  test.each(tiers)("%s tier always renders the verdict chip AND the MDE line", (scenario, chipLabel) => {
    renderCard(scenario);
    // Verdict tier chip — always present.
    expect(screen.getByTestId("verdict-chip")).toHaveTextContent(chipLabel);
    // MDE line — always present, with the "can detect differences" phrasing.
    expect(screen.getByTestId("mde-line")).toHaveTextContent(/can detect differences ≥ \d+pp/);
    // The primary metric and disclosures are rendered.
    expect(screen.getByTestId("conclusion")).toBeInTheDocument();
    expect(screen.getByTestId("disclosures")).toHaveTextContent(/84 tasks × 3 trials/);
  });

  test("the deterministic fake runner is reproducible for a given scenario", () => {
    const a = cardFor("clear");
    const b = cardFor("clear");
    expect(a.stats.pairedDelta.est).toBe(b.stats.pairedDelta.est);
    expect(a.conclusion).toBe(b.conclusion);
  });

  test("clear tier names a winner; underpowered does not", () => {
    expect(cardFor("clear").conclusion).toMatch(/resolves .* more than/);
    expect(cardFor("underpowered").conclusion).toMatch(/underpowered/i);
    expect(cardFor("underpowered").conclusion).not.toMatch(/resolves .* more than/);
  });
});
