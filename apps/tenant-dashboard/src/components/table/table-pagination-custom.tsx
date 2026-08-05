import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import TablePagination, {
  TablePaginationProps,
} from "@mui/material/TablePagination";
import { SxProps, Theme } from "@mui/material/styles";

// ----------------------------------------------------------------------

type Props = {
  dense?: boolean;
  onChangeDense?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  sx?: SxProps<Theme>;
};

export default function TablePaginationCustom({
  dense,
  onChangeDense,
  rowsPerPageOptions = [5, 10, 25],
  sx,
  ...other
}: Props & TablePaginationProps) {
  return (
    <Box sx={{ position: "relative", ...sx }}>
      <TablePagination
        component="div"
        rowsPerPageOptions={rowsPerPageOptions}
        {...other}
        sx={{ borderTopColor: "transparent" }}
      />

      {onChangeDense && (
        <FormControlLabel
          label="Dense"
          control={<Switch checked={dense} onChange={onChangeDense} />}
          sx={{
            pl: 2,
            py: 1.5,
            top: 0,
            position: { sm: "absolute" },
          }}
        />
      )}
    </Box>
  );
}
