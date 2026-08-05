import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableSortLabel from "@mui/material/TableSortLabel";
import { SxProps, Theme } from "@mui/material/styles";
import { visuallyHidden } from "@mui/utils";

// ----------------------------------------------------------------------

type HeadCell = {
  id: string;
  label?: React.ReactNode;
  align?: "left" | "right" | "center" | "inherit" | "justify";
  width?: number | string;
  minWidth?: number | string;
};

type Props = {
  order?: "asc" | "desc";
  orderBy?: string;
  headLabel: HeadCell[];
  rowCount?: number;
  numSelected?: number;
  onSort?: (id: string) => void;
  onSelectAllRows?: (checked: boolean) => void;
  sx?: SxProps<Theme>;
};

export default function TableHeadCustom({
  order,
  orderBy,
  rowCount = 0,
  headLabel,
  numSelected = 0,
  onSort,
  onSelectAllRows,
  sx,
}: Props) {
  return (
    <TableHead sx={sx}>
      <TableRow>
        {onSelectAllRows && (
          <TableCell padding="checkbox">
            <Checkbox
              indeterminate={!!numSelected && numSelected < rowCount}
              checked={!!rowCount && numSelected === rowCount}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                onSelectAllRows(event.target.checked)
              }
            />
          </TableCell>
        )}

        {headLabel.map((headCell) => {
          const active = orderBy === headCell.id;

          return (
            <TableCell
              key={headCell.id}
              align={headCell.align || "left"}
              sortDirection={active ? order : false}
              sx={{ width: headCell.width, minWidth: headCell.minWidth }}
            >
              {onSort ? (
                <TableSortLabel
                  hideSortIcon
                  active={active}
                  direction={active ? order : "asc"}
                  onClick={() => onSort(headCell.id)}
                >
                  {headCell.label}

                  {active ? (
                    <Box component="span" sx={visuallyHidden}>
                      {order === "desc"
                        ? "sorted descending"
                        : "sorted ascending"}
                    </Box>
                  ) : null}
                </TableSortLabel>
              ) : (
                headCell.label
              )}
            </TableCell>
          );
        })}
      </TableRow>
    </TableHead>
  );
}
