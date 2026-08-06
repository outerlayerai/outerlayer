// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders the title as a level-6 heading with the description beneath it", () => {
    render(<EmptyState title="No dashboards yet" description="Create a dashboard to track your fleet." />);

    expect(screen.getByRole("heading", { level: 6 }).textContent).toBe("No dashboards yet");
    expect(screen.getByText("Create a dashboard to track your fleet.")).not.toBe(
      screen.getByRole("heading", { level: 6 })
    );
  });

  it("wraps the card variant in a Card", () => {
    const { container } = render(<EmptyState title="No topics yet" data-testid="state" />);

    const root = screen.getByTestId("state");
    expect(root.dataset.variant).toBe("card");
    expect(root.classList.contains("MuiCard-root")).toBe(true);
    expect(container.querySelectorAll(".MuiCard-root")).toHaveLength(1);
  });

  it("renders the dashed variant with a dashed outline and no Card", () => {
    const { container } = render(
      <EmptyState variant="dashed" title="No dashboards yet" data-testid="state" />
    );

    const root = screen.getByTestId("state");
    expect(root.dataset.variant).toBe("dashed");
    expect(container.querySelector(".MuiCard-root")).toBeNull();
    // Longhand rather than the `borderStyle` shorthand: jsdom serializes the
    // shorthand per-side, so the shorthand read is not a stable equality target.
    expect(getComputedStyle(root).borderTopStyle).toBe("dashed");
  });

  it("gives the card variant no dashed outline", () => {
    render(<EmptyState title="No topics yet" data-testid="state" />);

    expect(getComputedStyle(screen.getByTestId("state")).borderTopStyle).not.toBe("dashed");
  });

  it("renders the action when given and no button otherwise", () => {
    const { unmount } = render(
      <EmptyState title="No dashboards yet" action={<button type="button">Create</button>} />
    );
    expect(screen.getByRole("button", { name: "Create" }).textContent).toBe("Create");

    unmount();

    render(<EmptyState title="No dashboards yet" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no description node when the description is omitted", () => {
    const { container } = render(<EmptyState title="No topics yet" />);

    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("defaults its test id and honours an override", () => {
    const { unmount } = render(<EmptyState title="No topics yet" />);
    expect(screen.getByTestId("empty-state").dataset.variant).toBe("card");

    unmount();

    render(<EmptyState title="No topics yet" variant="dashed" data-testid="queues-empty" />);
    expect([
      screen.getByTestId("queues-empty").dataset.variant,
      screen.queryByTestId("empty-state"),
    ]).toEqual(["dashed", null]);
  });

  it("renders meta between the description and the action, in neither slot", () => {
    render(
      <EmptyState
        title="No topics yet"
        description="Topics cluster once enough summaries land."
        meta={<span>40 of 100 summaries collected</span>}
        action={<button type="button">Generate</button>}
      />
    );

    const meta = screen.getByTestId("empty-state-meta");
    const description = screen.getByText("Topics cluster once enough summaries land.");
    const action = screen.getByRole("button", { name: "Generate" });

    expect([
      meta.textContent,
      description.contains(meta),
      meta.contains(action),
      Boolean(description.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING),
      Boolean(meta.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING),
    ]).toEqual(["40 of 100 summaries collected", false, false, true, true]);
  });

  it("renders no meta node when meta is omitted", () => {
    render(<EmptyState title="No topics yet" action={<button type="button">Generate</button>} />);

    expect(screen.queryByTestId("empty-state-meta")).toBeNull();
  });

  it("scopes the meta node under a test id override", () => {
    render(
      <EmptyState title="No topics yet" meta={<span>40 of 100</span>} data-testid="topics-empty" />
    );

    expect([
      screen.getByTestId("topics-empty-meta").textContent,
      screen.queryByTestId("empty-state-meta"),
    ]).toEqual(["40 of 100", null]);
  });

  it("renders the icon above the heading", () => {
    render(<EmptyState title="No dashboards yet" icon={<span data-testid="icon" />} />);

    const icon = screen.getByTestId("icon");
    const heading = screen.getByRole("heading", { level: 6 });

    expect(icon.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
