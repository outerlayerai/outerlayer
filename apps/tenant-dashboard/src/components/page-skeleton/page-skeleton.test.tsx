// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageSkeleton, type PageSkeletonVariant } from "./page-skeleton";

/** The landmark each variant must render — and, for every other variant, must not. */
const LANDMARKS: Record<PageSkeletonVariant, string> = {
  "table-page": "page-skeleton-rows",
  "card-grid": "page-skeleton-grid",
  "two-pane": "page-skeleton-rail",
  "settings-form": "page-skeleton-fields",
};

const VARIANTS = Object.keys(LANDMARKS) as PageSkeletonVariant[];

describe("PageSkeleton", () => {
  it.each(VARIANTS)("renders only the %s landmark", (variant) => {
    render(<PageSkeleton variant={variant} />);

    expect(screen.getByTestId("page-skeleton").dataset.variant).toBe(variant);

    const present = VARIANTS.filter((v) => screen.queryByTestId(LANDMARKS[v]) !== null);
    expect(present).toEqual([variant]);
  });

  it("reserves the two-pane rail at the real file-tree width", () => {
    render(<PageSkeleton variant="two-pane" />);

    // The destination rail is 300px. A placeholder at any other width shifts
    // both panes the moment data lands — the exact reflow this component is
    // here to prevent, and one that no landmark-presence assertion can see.
    expect(getComputedStyle(screen.getByTestId("page-skeleton-rail")).width).toBe("300px");
  });

  it("renders exactly one card per requested row in the card grid", () => {
    render(<PageSkeleton variant="card-grid" rows={4} />);

    expect(screen.getAllByTestId("page-skeleton-card")).toHaveLength(4);
  });

  it("renders the requested body rows plus a single header row in the table", () => {
    render(<PageSkeleton variant="table-page" rows={3} />);

    expect(screen.getAllByTestId("page-skeleton-row")).toHaveLength(3);
    expect(screen.getAllByTestId("page-skeleton-head-row")).toHaveLength(1);
  });

  it("renders exactly one field group per requested row in the settings form", () => {
    render(<PageSkeleton variant="settings-form" rows={6} />);

    expect(screen.getAllByTestId("page-skeleton-field")).toHaveLength(6);
  });

  it("falls back to the variant's own default count", () => {
    const { unmount } = render(<PageSkeleton variant="card-grid" />);
    expect(screen.getAllByTestId("page-skeleton-card")).toHaveLength(6);

    unmount();

    render(<PageSkeleton variant="settings-form" />);
    expect(screen.getAllByTestId("page-skeleton-field")).toHaveLength(4);
  });

  it("drops the header block while keeping the body", () => {
    render(<PageSkeleton variant="table-page" header={false} rows={2} />);

    expect(screen.queryByTestId("page-skeleton-header")).toBeNull();
    expect(screen.getAllByTestId("page-skeleton-row")).toHaveLength(2);
  });

  it("renders the header block by default", () => {
    render(<PageSkeleton variant="table-page" />);

    expect(screen.getAllByTestId("page-skeleton-header")).toHaveLength(1);
  });

  it("reserves the header action by default and drops only that placeholder when told to", () => {
    const { unmount } = render(<PageSkeleton variant="card-grid" />);
    expect([
      screen.getAllByTestId("page-skeleton-header-action").length,
      screen.getAllByTestId("page-skeleton-header").length,
    ]).toEqual([1, 1]);

    unmount();

    render(<PageSkeleton variant="card-grid" headerAction={false} />);
    expect([
      screen.queryByTestId("page-skeleton-header-action"),
      screen.getAllByTestId("page-skeleton-header").length,
    ]).toEqual([null, 1]);
  });

  it("reserves the filter bar and pager by default and drops each independently", () => {
    const { unmount } = render(<PageSkeleton variant="table-page" rows={2} />);
    expect([
      screen.getAllByTestId("page-skeleton-filter-bar").length,
      screen.getAllByTestId("page-skeleton-pager").length,
    ]).toEqual([1, 1]);

    unmount();

    const noFilter = render(<PageSkeleton variant="table-page" rows={2} filterBar={false} />);
    expect([
      screen.queryByTestId("page-skeleton-filter-bar"),
      screen.getAllByTestId("page-skeleton-pager").length,
      screen.getAllByTestId("page-skeleton-row").length,
    ]).toEqual([null, 1, 2]);

    noFilter.unmount();

    render(<PageSkeleton variant="table-page" rows={2} pager={false} />);
    expect([
      screen.getAllByTestId("page-skeleton-filter-bar").length,
      screen.queryByTestId("page-skeleton-pager"),
      screen.getAllByTestId("page-skeleton-row").length,
    ]).toEqual([1, null, 2]);
  });

  it("places the leading block between the header and the body", () => {
    render(
      <PageSkeleton variant="table-page" rows={2} leading={<div data-testid="chart" />} />
    );

    const leading = screen.getByTestId("page-skeleton-leading");
    const header = screen.getByTestId("page-skeleton-header");
    const rows = screen.getByTestId("page-skeleton-rows");

    expect([
      leading.contains(screen.getByTestId("chart")),
      Boolean(header.compareDocumentPosition(leading) & Node.DOCUMENT_POSITION_FOLLOWING),
      Boolean(leading.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING),
    ]).toEqual([true, true, true]);
  });

  it("renders no leading block when none is supplied", () => {
    render(<PageSkeleton variant="table-page" rows={2} />);

    expect(screen.queryByTestId("page-skeleton-leading")).toBeNull();
  });

  it("scopes the composition landmarks under a test id override", () => {
    render(
      <PageSkeleton
        variant="table-page"
        rows={2}
        leading={<div />}
        data-testid="traces-skeleton"
      />
    );

    expect([
      screen.getAllByTestId("traces-skeleton-header-action").length,
      screen.getAllByTestId("traces-skeleton-filter-bar").length,
      screen.getAllByTestId("traces-skeleton-pager").length,
      screen.getAllByTestId("traces-skeleton-leading").length,
      screen.queryByTestId("page-skeleton-header-action"),
      screen.queryByTestId("page-skeleton-filter-bar"),
      screen.queryByTestId("page-skeleton-pager"),
      screen.queryByTestId("page-skeleton-leading"),
    ]).toEqual([1, 1, 1, 1, null, null, null, null]);
  });

  it("puts announceable loading text inside its status region", () => {
    render(<PageSkeleton variant="two-pane" />);

    const status = screen.getByRole("status");

    expect(status).toBe(screen.getByTestId("page-skeleton"));
    // The announced text, not the accessible name: a live region is announced
    // from its content, and `status` is not named from content.
    expect(status).toHaveTextContent("Loading");
    // `aria-busy` on the region would defer that announcement until it clears,
    // and it never clears — the region unmounts when the data arrives.
    expect(status.getAttribute("aria-busy")).toBeNull();
  });

  it("defaults its test id and scopes every landmark under an override", () => {
    const { unmount } = render(<PageSkeleton variant="table-page" rows={2} />);
    expect([
      screen.getByTestId("page-skeleton").dataset.variant,
      screen.getAllByTestId("page-skeleton-row").length,
      screen.getAllByTestId("page-skeleton-header").length,
    ]).toEqual(["table-page", 2, 1]);

    unmount();

    render(<PageSkeleton variant="table-page" rows={2} data-testid="traces-skeleton" />);
    expect([
      screen.getByTestId("traces-skeleton").dataset.variant,
      screen.getAllByTestId("traces-skeleton-row").length,
      screen.getAllByTestId("traces-skeleton-header").length,
      screen.queryByTestId("page-skeleton"),
      screen.queryByTestId("page-skeleton-row"),
      screen.queryByTestId("page-skeleton-header"),
    ]).toEqual(["table-page", 2, 1, null, null, null]);
  });
});
