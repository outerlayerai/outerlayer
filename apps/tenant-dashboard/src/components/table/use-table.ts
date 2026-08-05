import { useState, useCallback } from "react";

import { TableProps } from "./types";

// ----------------------------------------------------------------------

type UseTableProps = {
  defaultDense?: boolean;
  defaultOrder?: "asc" | "desc";
  defaultOrderBy?: string;
  defaultSelected?: string[];
  defaultRowsPerPage?: number;
  defaultCurrentPage?: number;
};

export default function useTable(props?: UseTableProps): TableProps {
  const [dense, setDense] = useState(!!props?.defaultDense);
  const [page, setPage] = useState(props?.defaultCurrentPage ?? 0);
  const [orderBy, setOrderBy] = useState(props?.defaultOrderBy ?? "name");
  const [rowsPerPage, setRowsPerPage] = useState(
    props?.defaultRowsPerPage ?? 10,
  );
  const [order, setOrder] = useState<"asc" | "desc">(
    props?.defaultOrder ?? "asc",
  );
  const [selected, setSelected] = useState<string[]>(
    props?.defaultSelected ?? [],
  );

  const onSort = useCallback(
    (id: string) => {
      if (id === "") return;
      const isAsc = orderBy === id && order === "asc";
      setOrder(isAsc ? "desc" : "asc");
      setOrderBy(id);
    },
    [order, orderBy],
  );

  const onSelectRow = useCallback((id: string) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  }, []);

  const onSelectAllRows = useCallback(
    (checked: boolean, newSelecteds: string[]) => {
      setSelected(checked ? newSelecteds : []);
    },
    [],
  );

  const onChangeRowsPerPage = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setPage(0);
      setRowsPerPage(parseInt(event.target.value, 10));
    },
    [],
  );

  const onChangeDense = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setDense(event.target.checked);
    },
    [],
  );

  const onChangePage = useCallback((_event: unknown, newPage: number) => {
    setPage(newPage);
  }, []);

  const onResetPage = useCallback(() => {
    setPage(0);
  }, []);

  const onUpdatePageDeleteRow = useCallback(
    (totalRowsInPage: number) => {
      setSelected([]);
      if (page && totalRowsInPage < 2) {
        setPage(page - 1);
      }
    },
    [page],
  );

  const onUpdatePageDeleteRows = useCallback(
    ({
      totalRows,
      totalRowsInPage,
      totalRowsFiltered,
    }: {
      totalRows: number;
      totalRowsInPage: number;
      totalRowsFiltered: number;
    }) => {
      const totalSelected = selected.length;

      setSelected([]);

      if (page) {
        if (totalSelected === totalRowsInPage) {
          setPage(page - 1);
        } else if (totalSelected === totalRowsFiltered) {
          setPage(0);
        } else if (totalSelected > totalRowsInPage) {
          setPage(Math.ceil((totalRows - totalSelected) / rowsPerPage) - 1);
        }
      }
    },
    [page, rowsPerPage, selected.length],
  );

  return {
    dense,
    page,
    order,
    orderBy,
    rowsPerPage,
    //
    selected,
    onSelectRow,
    onSelectAllRows,
    //
    onResetPage,
    onSort,
    onChangePage,
    onChangeRowsPerPage,
    onChangeDense,
    onUpdatePageDeleteRow,
    onUpdatePageDeleteRows,
    //
    setPage,
    setDense,
    setOrder,
    setOrderBy,
    setSelected,
    setRowsPerPage,
  };
}
