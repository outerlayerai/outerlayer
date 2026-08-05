// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TablePager } from "./table-pager";

const noop = () => {};

function renderPager(props: Partial<React.ComponentProps<typeof TablePager>> = {}) {
  return render(
    <TablePager page={0} pageSize={25} total={100} onPrev={noop} onNext={noop} {...props} />
  );
}

const prev = () => screen.getByRole("button", { name: /Prev/ });
const next = () => screen.getByRole("button", { name: /Next/ });
const range = () => screen.getByTestId("table-pager-range").textContent;
const position = () => screen.getByTestId("table-pager-position").textContent;

describe("TablePager", () => {
  const cases = [
    {
      name: "first page of several",
      props: { page: 0, pageSize: 25, total: 100 },
      range: "1–25 of 100",
      position: "1 / 4",
      prevDisabled: true,
      nextDisabled: false,
    },
    {
      name: "a middle page",
      props: { page: 1, pageSize: 25, total: 100 },
      range: "26–50 of 100",
      position: "2 / 4",
      prevDisabled: false,
      nextDisabled: false,
    },
    {
      name: "a last page that fills exactly",
      props: { page: 3, pageSize: 25, total: 100 },
      range: "76–100 of 100",
      position: "4 / 4",
      prevDisabled: false,
      nextDisabled: true,
    },
    {
      name: "a single page that fills exactly",
      props: { page: 0, pageSize: 25, total: 25 },
      range: "1–25 of 25",
      position: "1 / 1",
      prevDisabled: true,
      nextDisabled: true,
    },
    {
      name: "a ragged last page holding one row",
      props: { page: 3, pageSize: 25, total: 76 },
      range: "76–76 of 76",
      position: "4 / 4",
      prevDisabled: false,
      nextDisabled: true,
    },
    {
      name: "a partial single page",
      props: { page: 0, pageSize: 25, total: 7 },
      range: "1–7 of 7",
      position: "1 / 1",
      prevDisabled: true,
      nextDisabled: true,
    },
    {
      name: "no matches at all",
      props: { page: 0, pageSize: 25, total: 0 },
      range: "no items match",
      position: "0 / 0",
      prevDisabled: true,
      nextDisabled: true,
    },
    {
      name: "a total that needs a thousands separator",
      props: { page: 0, pageSize: 25, total: 1234 },
      range: "1–25 of 1,234",
      position: "1 / 50",
      prevDisabled: true,
      nextDisabled: false,
    },
    {
      name: "range endpoints that need a thousands separator",
      props: { page: 4000, pageSize: 25, total: 1234567 },
      range: "100,001–100,025 of 1,234,567",
      position: "4001 / 49383",
      prevDisabled: false,
      nextDisabled: false,
    },
    {
      name: "a page stranded past a shrunken result set",
      props: { page: 3, pageSize: 25, total: 25 },
      range: "1–25 of 25",
      position: "1 / 1",
      prevDisabled: false,
      nextDisabled: true,
    },
    {
      name: "a page stranded past a ragged last page",
      props: { page: 9, pageSize: 25, total: 30 },
      range: "26–30 of 30",
      position: "2 / 2",
      prevDisabled: false,
      nextDisabled: true,
    },
    {
      name: "a page stranded past an emptied result set",
      props: { page: 3, pageSize: 25, total: 0 },
      range: "no items match",
      position: "0 / 0",
      prevDisabled: false,
      nextDisabled: true,
    },
  ];

  it.each(cases)("reports $name", ({ props, ...expected }) => {
    renderPager(props);

    expect([range(), position(), prev().hasAttribute("disabled"), next().hasAttribute("disabled")]).toEqual([
      expected.range,
      expected.position,
      expected.prevDisabled,
      expected.nextDisabled,
    ]);
  });

  it("names the items in the no-results line", () => {
    renderPager({ total: 0, itemNoun: "sessions" });

    expect(range()).toBe("no sessions match");
  });

  it("calls only onPrev when Prev is clicked", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    renderPager({ page: 1, onPrev, onNext });

    fireEvent.click(prev());

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledWith();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("calls only onNext when Next is clicked", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    renderPager({ page: 1, onPrev, onNext });

    fireEvent.click(next());

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("fires no callback while rendering a stranded page", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    renderPager({ page: 3, pageSize: 25, total: 25, onPrev, onNext });

    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("defaults its test id and scopes the readouts under an override", () => {
    const { unmount } = renderPager();
    expect([
      screen.getByTestId("table-pager").tagName,
      screen.getByTestId("table-pager-range").textContent,
      screen.getByTestId("table-pager-position").textContent,
    ]).toEqual(["DIV", "1–25 of 100", "1 / 4"]);

    unmount();

    renderPager({ "data-testid": "sessions-pager" });
    expect([
      screen.getByTestId("sessions-pager-range").textContent,
      screen.getByTestId("sessions-pager-position").textContent,
      screen.queryByTestId("table-pager"),
      screen.queryByTestId("table-pager-range"),
    ]).toEqual(["1–25 of 100", "1 / 4", null, null]);
  });

  it("formats the range without consulting the ambient locale", () => {
    // The separator cases above all pass under a reverted, ambient-locale
    // `toLocaleString()`, because the test runtime's default locale is already
    // en-US. Pinning the SSR-vs-client hydration mismatch takes proving the
    // ambient formatter is never reached: on a visitor whose locale renders
    // 1.234.567, the server and the browser would disagree on this text.
    const ambient = vi
      .spyOn(Number.prototype, "toLocaleString")
      .mockReturnValue("AMBIENT_LOCALE");

    try {
      renderPager({ page: 4000, pageSize: 25, total: 1234567 });

      expect([range(), position(), ambient.mock.calls.length]).toEqual([
        "100,001–100,025 of 1,234,567",
        "4001 / 49383",
        0,
      ]);
    } finally {
      ambient.mockRestore();
    }
  });

  it("fires nothing from the disabled edges", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    renderPager({ page: 0, pageSize: 25, total: 25, onPrev, onNext });

    fireEvent.click(prev());
    fireEvent.click(next());

    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });
});
