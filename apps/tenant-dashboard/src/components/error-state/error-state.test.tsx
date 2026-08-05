// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "../empty-state";
import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  it("renders the title as a level-6 heading with the reason beneath it", () => {
    render(
      <ErrorState
        title="Couldn't load topics"
        description="ClickHouse read timed out."
        onRetry={() => {}}
      />
    );

    const heading = screen.getByRole("heading", { level: 6 });
    const description = screen.getByText("ClickHouse read timed out.");

    expect([heading.textContent, description === heading, heading.contains(description)]).toEqual([
      "Couldn't load topics",
      false,
      false,
    ]);
  });

  it("renders no description node when the description is omitted", () => {
    const { container } = render(<ErrorState title="Couldn't load topics" onRetry={() => {}} />);

    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("calls onRetry once per click with no arguments", async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Couldn't load topics" onRetry={onRetry} />);

    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));

    // Zero arguments, not just "was called": the handler is declared
    // zero-argument, so forwarding the click event would feed a caller's
    // first parameter a MouseEvent.
    expect(onRetry.mock.calls).toEqual([[]]);
  });

  it("labels the retry with an override without changing what it calls", async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState title="Couldn't load the run" retryLabel="Re-run query" onRetry={onRetry} />
    );

    await userEvent.click(screen.getByRole("button", { name: "Re-run query" }));

    expect([screen.queryByRole("button", { name: "Retry now" }), onRetry.mock.calls]).toEqual([
      null,
      [[]],
    ]);
  });

  it("defaults its test id and scopes the retry under an override", () => {
    const { unmount } = render(<ErrorState title="Couldn't load topics" onRetry={() => {}} />);
    expect(screen.getByTestId("error-state-retry").textContent).toBe("Retry now");

    unmount();

    render(
      <ErrorState title="Couldn't load topics" onRetry={() => {}} data-testid="topics-error" />
    );
    expect([
      screen.getByTestId("topics-error-retry").textContent,
      screen.queryByTestId("error-state"),
      screen.queryByTestId("error-state-retry"),
    ]).toEqual(["Retry now", null, null]);
  });

  it("stays distinguishable from an empty state carrying the same words", () => {
    // The two cards look alike, which is exactly why they must not become one:
    // a failed fetch rendered as an empty state tells the user their data is
    // gone. Collapsing ErrorState onto EmptyState — as a variant, a wrapper, or
    // a shared render path — breaks at least one column of this table.
    const { unmount } = render(
      <ErrorState title="Topics" description="Same words." onRetry={() => {}} />
    );
    const error = screen.getByTestId("error-state");
    const errorShape = [
      error.getAttribute("role"),
      error.dataset.testid,
      screen.queryAllByRole("button").length,
      screen.queryByTestId("empty-state"),
    ];

    unmount();

    render(<EmptyState title="Topics" description="Same words." />);
    const empty = screen.getByTestId("empty-state");
    const emptyShape = [
      empty.getAttribute("role"),
      empty.dataset.testid,
      screen.queryAllByRole("button").length,
      screen.queryByTestId("empty-state"),
    ];

    expect([errorShape, emptyShape]).toEqual([
      ["alert", "error-state", 1, null],
      [null, "empty-state", 0, empty],
    ]);
  });
});
