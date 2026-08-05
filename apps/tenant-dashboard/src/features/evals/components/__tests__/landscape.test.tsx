// @vitest-environment jsdom
/**
 * Landscape scatter — the multi-config comparison view.
 * The logic under test is the Pareto frontier: which configs are dominated
 * (beaten on BOTH resolve rate and $/resolved-task).
 */

vi.mock("@mui/x-data-grid", () => ({}));

import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { EvalLandscape } from "../eval-landscape";
import { paretoFront, sampleLandscape, type LandscapePoint } from "../landscape";

describe("paretoFront", () => {
  test("marks configs beaten on both axes as dominated", () => {
    const points: LandscapePoint[] = [
      { configId: "a", resolveRate: 0.64, resolveCi95: [0.55, 0.72], dollarsPerResolved: 0.66, dollarCi95: [0.56, 0.78] }, // highest resolve → front
      { configId: "b", resolveRate: 0.6, resolveCi95: [0.51, 0.68], dollarsPerResolved: 0.24, dollarCi95: [0.19, 0.3] }, // front
      { configId: "c", resolveRate: 0.58, resolveCi95: [0.49, 0.66], dollarsPerResolved: 0.28, dollarCi95: [0.22, 0.35] }, // b dominates c
      { configId: "d", resolveRate: 0.52, resolveCi95: [0.43, 0.61], dollarsPerResolved: 0.13, dollarCi95: [0.1, 0.17] }, // cheapest → front
    ];
    const front = paretoFront(points);
    expect([...front].sort()).toEqual(["a", "b", "d"]);
    expect(front.has("c")).toBe(false); // b is cheaper AND higher-resolve
  });

  test("the sample landscape has exactly two dominated configs (the teaching case)", () => {
    const front = paretoFront(sampleLandscape());
    expect(front.has("opus-4.8")).toBe(true);
    expect(front.has("codex-gpt-5.5")).toBe(true);
    expect(front.has("glm-5.2")).toBe(true);
    expect(front.has("sonnet-5")).toBe(false); // dominated by codex
    expect(front.has("opencode-qwen")).toBe(false); // dominated by glm/codex
  });
});

describe("EvalLandscape render", () => {
  test("renders a point per config, honest axes, and the CI/Pareto explanation", () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <EvalLandscape points={sampleLandscape()} repoLabel="acme/payments-api" />
      </ThemeProvider>,
    );
    for (const id of ["opus-4.8", "codex-gpt-5.5", "sonnet-5", "glm-5.2", "opencode-qwen"]) {
      expect(screen.getByTestId(`landscape-point-${id}`)).toBeInTheDocument();
    }
    // Honest axes named, not "quality"/"$ per token".
    expect(screen.getByText("$ per resolved task")).toBeInTheDocument();
    expect(screen.getByText("Resolve rate")).toBeInTheDocument();
    // The caption explains the frontier + that axes are execution-verified.
    expect(screen.getByTestId("landscape-caption")).toHaveTextContent(/Pareto frontier/);
    expect(screen.getByTestId("landscape-caption")).toHaveTextContent(/execution-verified/);
  });
});
