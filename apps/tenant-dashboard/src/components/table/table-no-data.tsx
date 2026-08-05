import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import { SxProps, Theme } from "@mui/material/styles";

import EmptyContent from "@/components/empty-content";

// ----------------------------------------------------------------------

// Spans wide enough to cover any consumer's column count.
const COL_SPAN = 12;

type Props = {
  notFound: boolean;
  title: string;
  sx?: SxProps<Theme>;
};

export default function TableNoData({ title, notFound, sx }: Props) {
  if (!notFound) {
    return (
      <TableRow>
        <TableCell colSpan={COL_SPAN} sx={{ p: 0 }} />
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell colSpan={COL_SPAN}>
        <EmptyContent filled title={title} sx={{ py: 10, ...sx }} />
      </TableCell>
    </TableRow>
  );
}
