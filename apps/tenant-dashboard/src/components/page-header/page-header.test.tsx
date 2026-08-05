// @vitest-environment jsdom
import { Chip } from "@mui/material";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

/** Tags that may not contain flow content, so a block child inside one is invalid. */
const PHRASING_ONLY = ["P", "SPAN", "LABEL", "H1", "H2", "H3", "H4", "H5", "H6"];

/** The ancestor chain from `node` up to (but excluding) `root`. */
const ancestorTags = (node: Element, root: Element) => {
  const tags: string[] = [];
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    tags.push(el.tagName);
  }
  return tags;
};

describe("PageHeader", () => {
  it("renders the title as a level-4 heading", () => {
    render(<PageHeader title="Benchmarks" />);

    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe("Benchmarks");
  });

  it("renders the caption as a node separate from the title", () => {
    render(<PageHeader title="Context" caption="acme/web · main" />);

    const heading = screen.getByRole("heading", { level: 4 });
    const caption = screen.getByText("acme/web · main");

    expect(heading.textContent).toBe("Context");
    expect(caption).not.toBe(heading);
    expect(heading.contains(caption)).toBe(false);
  });

  it("renders no caption node when the caption is omitted", () => {
    const { container } = render(<PageHeader title="Context" />);

    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("renders actions inside the actions slot, not the title column", () => {
    render(<PageHeader title="Dashboards" actions={<button type="button">New</button>} />);

    const action = screen.getByRole("button", { name: "New" });
    const slot = screen.getByTestId("page-header-actions");

    expect(slot.contains(action)).toBe(true);
    expect(action.closest("[data-testid='page-header-actions']")).toBe(slot);
    expect(slot.contains(screen.getByRole("heading", { level: 4 }))).toBe(false);
  });

  it("renders no actions slot when there are no actions", () => {
    render(<PageHeader title="Dashboards" />);

    expect(screen.queryByTestId("page-header-actions")).toBeNull();
  });

  it("defaults its test id and scopes the actions slot under an override", () => {
    const actions = <button type="button">New</button>;
    const { unmount } = render(<PageHeader title="Dashboards" actions={actions} />);
    expect([
      screen.getByTestId("page-header").tagName,
      screen.getByTestId("page-header-actions").textContent,
    ]).toEqual(["DIV", "New"]);

    unmount();

    render(<PageHeader title="Dashboards" actions={actions} data-testid="detail-header" />);
    expect([
      screen.getByTestId("detail-header-actions").textContent,
      screen.queryByTestId("page-header"),
      screen.queryByTestId("page-header-actions"),
    ]).toEqual(["New", null, null]);
  });

  it("hosts a block-level caption child in a container that may legally contain it", () => {
    // jsdom does not enforce HTML content models, so the nesting has to be
    // asserted on the ancestor chain — the browser is where it would otherwise
    // surface, as a hydration error.
    render(<PageHeader title="Context" caption={<Chip label="main" />} />);

    const chip = screen.getByText("main");
    const root = screen.getByTestId("page-header");

    expect(chip.closest(".MuiChip-root")?.tagName).toBe("DIV");
    expect(ancestorTags(chip, root).filter((tag) => PHRASING_ONLY.includes(tag))).toEqual([]);
  });

  it("renders the meta block below the caption and outside both it and the title", () => {
    render(
      <PageHeader
        title="acme-agent"
        caption="Deployed 12 min ago"
        meta={<Chip label="production" />}
      />
    );

    const meta = screen.getByTestId("page-header-meta");
    const caption = screen.getByTestId("page-header-caption");
    const heading = screen.getByRole("heading", { level: 4 });

    expect([
      meta.contains(screen.getByText("production")),
      caption.contains(meta),
      heading.contains(meta),
      Boolean(
        caption.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
    ]).toEqual([true, false, false, true]);
  });

  it("renders no meta node when meta is omitted", () => {
    render(<PageHeader title="acme-agent" caption="Deployed 12 min ago" />);

    expect(screen.queryByTestId("page-header-meta")).toBeNull();
  });

  it("renders meta without a caption", () => {
    render(<PageHeader title="acme-agent" meta={<Chip label="production" />} />);

    expect([
      screen.getByTestId("page-header-meta").textContent,
      screen.queryByTestId("page-header-caption"),
    ]).toEqual(["production", null]);
  });

  it("scopes the caption and meta nodes under a test id override", () => {
    render(
      <PageHeader
        title="acme-agent"
        caption="acme/web · main"
        meta={<Chip label="production" />}
        data-testid="detail-header"
      />
    );

    expect([
      screen.getByTestId("detail-header-caption").textContent,
      screen.getByTestId("detail-header-meta").textContent,
      screen.queryByTestId("page-header-caption"),
      screen.queryByTestId("page-header-meta"),
    ]).toEqual(["acme/web · main", "production", null, null]);
  });

  it("lets the title row wrap and keeps the gap between the wrapped rows", () => {
    render(<PageHeader title="A very long page title" actions={<button type="button">New</button>} />);

    const style = getComputedStyle(screen.getByTestId("page-header"));

    // Margin-based spacing collapses the space between wrapped rows, so the
    // wrap and the gap are one assertion: `flexWrap` alone is not the fix.
    expect([style.flexWrap, style.gap === "" ? "" : style.gap]).toEqual(["wrap", "12px"]);
  });

  it("refuses to shrink, so a full-height page cannot compress it", () => {
    render(<PageHeader title="Context" caption="acme/web · main" />);

    // A fixed-height, non-scrolling page makes the header a flex sibling of a
    // body that claims every remaining pixel. At the flex default the header
    // loses that contest and compresses, which no assertion on its contents
    // would catch — the title is still present, just squeezed.
    expect(getComputedStyle(screen.getByTestId("page-header")).flexShrink).toBe("0");
  });

  it("places the leading node before the title in document order", () => {
    render(<PageHeader title="Context" leading={<button type="button">Files</button>} />);

    const leading = screen.getByRole("button", { name: "Files" });
    const heading = screen.getByRole("heading", { level: 4 });

    expect(leading.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
