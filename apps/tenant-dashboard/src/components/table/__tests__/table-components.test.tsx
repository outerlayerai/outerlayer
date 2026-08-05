// @vitest-environment jsdom
/**
 * Render contracts for the table primitives. Pins the head's column output +
 * select-all / sort wiring, the no-data empty-state text and its `colSpan`, the
 * skeleton's row count, and the pagination dense toggle.
 */
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import TableHeadCustom from "../table-head-custom";
import TableNoData from "../table-no-data";
import TablePaginationCustom from "../table-pagination-custom";

function renderInTable(node: React.ReactNode, withBody = true) {
  return render(
    <ThemeProvider theme={createAppTheme()}>
      <Table>{withBody ? <TableBody>{node}</TableBody> : node}</Table>
    </ThemeProvider>,
  );
}

const HEAD = [
  { id: "name", label: "Name" },
  { id: "email", label: "Email" },
];

describe("TableHeadCustom", () => {
  it("renders one header cell per headLabel entry", () => {
    renderInTable(<TableHeadCustom headLabel={HEAD} />, false);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("adds a select-all checkbox cell only when onSelectAllRows is passed", () => {
    const { rerender } = renderInTable(
      <TableHeadCustom headLabel={HEAD} />,
      false,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();

    rerender(
      <ThemeProvider theme={createAppTheme()}>
        <Table>
          <TableHeadCustom headLabel={HEAD} onSelectAllRows={vi.fn()} />
        </Table>
      </ThemeProvider>,
    );
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("checkbox is indeterminate for a partial selection", () => {
    renderInTable(
      <TableHeadCustom
        headLabel={HEAD}
        rowCount={4}
        numSelected={2}
        onSelectAllRows={vi.fn()}
      />,
      false,
    );
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.getAttribute("data-indeterminate")).toBe("true");
    expect(checkbox.checked).toBe(false);
  });

  it("checkbox is checked when every row is selected", () => {
    renderInTable(
      <TableHeadCustom
        headLabel={HEAD}
        rowCount={4}
        numSelected={4}
        onSelectAllRows={vi.fn()}
      />,
      false,
    );
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.getAttribute("data-indeterminate")).toBe("false");
  });

  it("fires onSort with the clicked column id", () => {
    const onSort = vi.fn();
    renderInTable(
      <TableHeadCustom headLabel={HEAD} onSort={onSort} />,
      false,
    );
    fireEvent.click(screen.getByText("Email"));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith("email");
  });

  it("renders plain header text (no sort control) when onSort is absent", () => {
    renderInTable(<TableHeadCustom headLabel={HEAD} />, false);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("TableNoData", () => {
  it("shows the empty-state title spanning 12 columns when notFound", () => {
    const { container } = renderInTable(
      <TableNoData notFound title="No results found" />,
    );
    expect(screen.getByText("No results found")).toBeInTheDocument();
    const cell = container.querySelector("td");
    expect(cell?.getAttribute("colspan")).toBe("12");
  });

  it("renders an empty spacer cell (no title) when not notFound", () => {
    const { container } = renderInTable(
      <TableNoData notFound={false} title="No results found" />,
    );
    expect(screen.queryByText("No results found")).toBeNull();
    const cell = container.querySelector("td");
    expect(cell?.getAttribute("colspan")).toBe("12");
    expect(cell?.textContent).toBe("");
  });
});


describe("TablePaginationCustom", () => {
  it("reflects the row count and omits the dense toggle by default", () => {
    render(
      <ThemeProvider theme={createAppTheme()}>
        <TablePaginationCustom
          count={42}
          page={0}
          rowsPerPage={10}
          onPageChange={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("1–10 of 42")).toBeInTheDocument();
    expect(screen.queryByText("Dense")).toBeNull();
  });

  it("renders the dense switch and toggles it via onChangeDense", () => {
    const onChangeDense = vi.fn();
    const { container } = render(
      <ThemeProvider theme={createAppTheme()}>
        <TablePaginationCustom
          count={42}
          page={0}
          rowsPerPage={10}
          onPageChange={vi.fn()}
          dense={false}
          onChangeDense={onChangeDense}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("Dense")).toBeInTheDocument();
    const denseInput = container.querySelector<HTMLInputElement>(
      '.MuiSwitch-root input[type="checkbox"]',
    );
    expect(denseInput).not.toBeNull();
    fireEvent.click(denseInput!);
    expect(onChangeDense).toHaveBeenCalledTimes(1);
  });
});
