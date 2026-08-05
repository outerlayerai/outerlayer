// @vitest-environment jsdom
/**
 * `AgentFindings` is a presentational render over the page a React Server
 * Component (RSC) seeds: it
 * gets the whole response as a prop and must never collapse to a bare
 * header — the failure mode that made an empty response show a blank page.
 */
import { render, screen } from "@testing-library/react";
import type { AgentFindingsResponse } from "../../types";

import { AgentFindings } from "../agent-findings";

const HEADING = "Findings";
const DESCRIPTION = /Systemic patterns across the fleet/;

const FINDING = {
  id: "f1",
  severity: "high",
  detectorId: "A5-error-loop",
  costUsd: 12.5,
  summary: "Repeated failing edits on src/a.ts",
  suggestion: "Break the loop",
  project: "github.com/acme/app",
  sessionIds: ["abcdef1234"],
  sessionCount: 1,
};

const EMPTY: AgentFindingsResponse = { findings: [], themes: [], computedAt: null };
const COMPUTED_AT = "2026-07-15T00:00:00.000Z";

test("the page title is an h4, the one page-title level", () => {
  render(<AgentFindings data={EMPTY} />);
  expect(screen.getByRole("heading", { name: HEADING }).tagName).toBe("H4");
});

test("the description reaches the shared header rather than a hand-rolled line", () => {
  render(<AgentFindings data={EMPTY} />);
  expect(screen.getByTestId("page-header")).toHaveTextContent(DESCRIPTION);
});

test("freshness sits in the header caption, not a page footer", () => {
  const { container } = render(<AgentFindings data={{ ...EMPTY, computedAt: COMPUTED_AT }} />);
  expect(screen.getByTestId("page-header-caption")).toHaveTextContent(/Computed/);
  // A freshness line trailing the body reads as a stray note. The header is the
  // frame's first child, so "Computed" surviving anywhere after it means the
  // footer is still there.
  const [header, ...rest] = Array.from(container.firstElementChild?.children ?? []);
  expect(header).toHaveAttribute("data-testid", "page-header");
  expect(rest.some((el) => /Computed/.test(el.textContent ?? ""))).toBe(false);
});

test("no freshness text at all when the detectors have never run", () => {
  render(<AgentFindings data={EMPTY} />);
  expect(screen.getByTestId("page-header-caption")).not.toHaveTextContent(/Computed/);
});

test("the page frame carries no width cap or centring of its own — the layout frame owns the column", () => {
  // A second capped, centred column nested inside the layout frame's own puts
  // this page on a different track from every sibling, and double-pads it.
  // emotion injects its classes into the document, so jsdom does resolve `sx`
  // through `getComputedStyle` — these read the real cascade, not inline style.
  const { container } = render(<AgentFindings data={EMPTY} />);
  const frame = container.firstElementChild as HTMLElement;
  expect(frame).toHaveAttribute("data-testid", "findings-page");
  const style = getComputedStyle(frame);
  // Unset properties compute to their initial values, so "no styling of its
  // own" reads as the initial value — a cap or centring would surface as
  // e.g. "1200px" / "auto" / "24px".
  expect(style.maxWidth).toBe("none");
  expect(style.marginLeft).toBe("0");
  expect(style.padding).toBe("0");
});

test("empty after a detector pass says the fleet is clean", () => {
  render(<AgentFindings data={{ ...EMPTY, computedAt: COMPUTED_AT }} />);
  const empty = screen.getByTestId("empty-state");
  expect(empty).toHaveAttribute("data-variant", "card");
  expect(screen.getByRole("heading", { name: "No findings in this window" })).toBeInTheDocument();
  expect(empty).toHaveTextContent(/flagged nothing/i);
});

test("empty with no detector pass yet says the data is missing, not that the fleet is clean", () => {
  render(<AgentFindings data={EMPTY} />);
  expect(screen.getByRole("heading", { name: "No findings computed yet" })).toBeInTheDocument();
  expect(screen.getByTestId("empty-state")).toHaveTextContent(/Once the first pass completes/i);
  // The two absences are different facts; neither may render the other's copy.
  expect(screen.queryByText(/flagged nothing/i)).not.toBeInTheDocument();
});

test("populated: renders a finding's summary and money, and no empty state", () => {
  render(<AgentFindings data={{ findings: [FINDING], themes: [], computedAt: COMPUTED_AT }} />);
  expect(screen.getByText("Repeated failing edits on src/a.ts")).toBeInTheDocument();
  expect(screen.getByText("$12.50")).toBeInTheDocument();
  // Populated is not empty: neither empty branch may fire alongside real data.
  expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /No findings/ })).not.toBeInTheDocument();
});

test("themes render alongside findings, ranked/labeled as the response ordered them", () => {
  const data: AgentFindingsResponse = {
    findings: [],
    themes: [
      { id: "th-1", label: "Stale file reads", description: "Edits failing against stale content.", severity: "warn", evidenceSessionIds: ["s1"] },
    ],
    computedAt: null,
  };
  render(<AgentFindings data={data} />);
  expect(screen.getByText("Stale file reads")).toBeInTheDocument();
  // Themes alone are still content — the empty branch must not fire.
  expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
});
