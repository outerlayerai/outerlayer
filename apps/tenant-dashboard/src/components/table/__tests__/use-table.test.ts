// @vitest-environment jsdom
/**
 * State-machine contract for `useTable` — the hook every list section in the
 * dashboard drives its sort / selection / pagination off. These assertions pin
 * the exact emitted state after each transition, including the delete-row page
 * clamps whose off-by-one arithmetic is easy to regress.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import useTable from "../use-table";

describe("useTable — defaults", () => {
  it("emits documented defaults with no props", () => {
    const { result } = renderHook(() => useTable());
    expect(result.current.dense).toBe(false);
    expect(result.current.page).toBe(0);
    expect(result.current.order).toBe("asc");
    expect(result.current.orderBy).toBe("name");
    expect(result.current.rowsPerPage).toBe(10);
    expect(result.current.selected).toEqual([]);
  });

  it("seeds state from provided defaults", () => {
    const { result } = renderHook(() =>
      useTable({
        defaultDense: true,
        defaultOrder: "desc",
        defaultOrderBy: "createdAt",
        defaultSelected: ["a", "b"],
        defaultRowsPerPage: 25,
        defaultCurrentPage: 3,
      }),
    );
    expect(result.current.dense).toBe(true);
    expect(result.current.order).toBe("desc");
    expect(result.current.orderBy).toBe("createdAt");
    expect(result.current.selected).toEqual(["a", "b"]);
    expect(result.current.rowsPerPage).toBe(25);
    expect(result.current.page).toBe(3);
  });
});

describe("useTable — onSort", () => {
  it("switches orderBy and defaults new column to asc", () => {
    const { result } = renderHook(() => useTable());
    act(() => result.current.onSort("email"));
    expect(result.current.orderBy).toBe("email");
    expect(result.current.order).toBe("asc");
  });

  it("toggles asc -> desc when sorting the active asc column", () => {
    const { result } = renderHook(() => useTable({ defaultOrderBy: "email" }));
    act(() => result.current.onSort("email"));
    expect(result.current.orderBy).toBe("email");
    expect(result.current.order).toBe("desc");
  });

  it("toggles desc -> asc when sorting the active desc column", () => {
    const { result } = renderHook(() =>
      useTable({ defaultOrderBy: "email", defaultOrder: "desc" }),
    );
    act(() => result.current.onSort("email"));
    expect(result.current.order).toBe("asc");
  });

  it("ignores an empty column id", () => {
    const { result } = renderHook(() => useTable({ defaultOrderBy: "email" }));
    act(() => result.current.onSort(""));
    expect(result.current.orderBy).toBe("email");
    expect(result.current.order).toBe("asc");
  });
});

describe("useTable — selection", () => {
  it("adds then removes an id via onSelectRow toggle", () => {
    const { result } = renderHook(() => useTable());
    act(() => result.current.onSelectRow("row-1"));
    expect(result.current.selected).toEqual(["row-1"]);
    act(() => result.current.onSelectRow("row-2"));
    expect(result.current.selected).toEqual(["row-1", "row-2"]);
    act(() => result.current.onSelectRow("row-1"));
    expect(result.current.selected).toEqual(["row-2"]);
  });

  it("selects all rows when checked, clears when unchecked", () => {
    const { result } = renderHook(() => useTable());
    act(() => result.current.onSelectAllRows(true, ["a", "b", "c"]));
    expect(result.current.selected).toEqual(["a", "b", "c"]);
    act(() => result.current.onSelectAllRows(false, ["a", "b", "c"]));
    expect(result.current.selected).toEqual([]);
  });
});

describe("useTable — pagination", () => {
  it("onChangeRowsPerPage sets rows and resets page to 0", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 4 }));
    act(() =>
      result.current.onChangeRowsPerPage({
        target: { value: "25" },
      } as React.ChangeEvent<HTMLInputElement>),
    );
    expect(result.current.rowsPerPage).toBe(25);
    expect(result.current.page).toBe(0);
  });

  it("onChangePage sets the given page", () => {
    const { result } = renderHook(() => useTable());
    act(() => result.current.onChangePage(null, 5));
    expect(result.current.page).toBe(5);
  });

  it("onResetPage returns to page 0", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 7 }));
    act(() => result.current.onResetPage());
    expect(result.current.page).toBe(0);
  });

  it("onChangeDense reflects the switch state", () => {
    const { result } = renderHook(() => useTable());
    act(() =>
      result.current.onChangeDense({
        target: { checked: true },
      } as React.ChangeEvent<HTMLInputElement>),
    );
    expect(result.current.dense).toBe(true);
  });
});

describe("useTable — delete-row page clamps", () => {
  it("onUpdatePageDeleteRow steps back a page when the last row on it goes", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 2 }));
    act(() => result.current.onUpdatePageDeleteRow(1));
    expect(result.current.page).toBe(1);
    expect(result.current.selected).toEqual([]);
  });

  it("onUpdatePageDeleteRow stays put when other rows remain on the page", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 2 }));
    act(() => result.current.onUpdatePageDeleteRow(3));
    expect(result.current.page).toBe(2);
  });

  it("onUpdatePageDeleteRow never underflows below page 0", () => {
    const { result } = renderHook(() => useTable());
    act(() => result.current.onUpdatePageDeleteRow(1));
    expect(result.current.page).toBe(0);
  });

  it("onUpdatePageDeleteRows steps back one page when the whole page is selected", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 2 }));
    act(() => result.current.onSelectAllRows(true, ["a", "b", "c"]));
    act(() =>
      result.current.onUpdatePageDeleteRows({
        totalRows: 23,
        totalRowsInPage: 3,
        totalRowsFiltered: 23,
      }),
    );
    expect(result.current.page).toBe(1);
    expect(result.current.selected).toEqual([]);
  });

  it("onUpdatePageDeleteRows jumps to page 0 when every filtered row is selected", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 2 }));
    act(() => result.current.onSelectAllRows(true, ["a", "b", "c"]));
    act(() =>
      result.current.onUpdatePageDeleteRows({
        totalRows: 23,
        totalRowsInPage: 5,
        totalRowsFiltered: 3,
      }),
    );
    expect(result.current.page).toBe(0);
  });

  it("onUpdatePageDeleteRows recomputes the page for a multi-page selection", () => {
    const { result } = renderHook(() => useTable({ defaultCurrentPage: 2 }));
    act(() =>
      result.current.onSelectAllRows(true, ["a", "b", "c", "d", "e"]),
    );
    act(() =>
      result.current.onUpdatePageDeleteRows({
        totalRows: 23,
        totalRowsInPage: 3,
        totalRowsFiltered: 100,
      }),
    );
    // ceil((23 - 5) / 10) - 1 = ceil(1.8) - 1 = 1
    expect(result.current.page).toBe(1);
  });

  it("onUpdatePageDeleteRows leaves page 0 untouched", () => {
    const { result } = renderHook(() => useTable());
    act(() => result.current.onSelectAllRows(true, ["a", "b", "c"]));
    act(() =>
      result.current.onUpdatePageDeleteRows({
        totalRows: 23,
        totalRowsInPage: 3,
        totalRowsFiltered: 23,
      }),
    );
    expect(result.current.page).toBe(0);
  });
});
