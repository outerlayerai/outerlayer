// @vitest-environment jsdom
/**
 * The run history table: per-row task/agent, status chip labels, the result
 * cell's four states (PR link / no changes / failure code / dash), duration
 * formatting, and row click. The empty case belongs to the enclosing section.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WorkerRunList } from "../worker-run-list";
import { WorkerRunStatusChip } from "../worker-run-status-chip";
import { runFixture } from "./workers-ui.helpers";

type Run = Parameters<typeof WorkerRunList>[0]["runs"][number];
const asRun = (over: Record<string, unknown> = {}) => runFixture(over) as unknown as Run;

describe("WorkerRunList", () => {
  it("renders a PR row, a no-changes row, a failed row, and an in-flight dash", async () => {
    const onSelect = vi.fn();
    render(
      <WorkerRunList
        onSelect={onSelect}
        runs={[
          asRun({ id: "a", pr_url: "https://github.com/o/r/pull/12", pr_number: 12 }),
          asRun({ id: "b", task_prompt: "cleanup", outcome: "no_changes", pr_url: null, duration_ms: 4_000 }),
          asRun({ id: "c", task_prompt: "hard task", status: "failed", outcome: null, pr_url: null, failure_code: "agent_error", error_message: "boom", duration_ms: null }),
          asRun({ id: "d", task_prompt: "fresh", status: "running", outcome: null, pr_url: null, duration_ms: null }),
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /PR #12/ })).toHaveAttribute(
      "href",
      "https://github.com/o/r/pull/12",
    );
    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(screen.getByText("agent_error")).toBeInTheDocument();
    expect(screen.getByText("1m 1s")).toBeInTheDocument();
    expect(screen.getByText("4s")).toBeInTheDocument();

    await userEvent.click(screen.getByText("cleanup"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});

describe("WorkerRunStatusChip", () => {
  it.each([
    ["queued", "Queued"],
    ["provisioning", "Provisioning"],
    ["running", "Running"],
    ["pushing", "Opening PR"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["timed_out", "Timed out"],
  ] as const)("labels %s as %s", (status, label) => {
    render(<WorkerRunStatusChip status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
