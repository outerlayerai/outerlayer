import Box, { type BoxProps } from "@mui/material/Box";

import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

// A bordered-flat "tile": a neutral rounded square holding a single line glyph.
// Used for the hero marks on the auth and error pages. Styling uses
// sx palette shorthands (not a `theme.vars` callback) so the tile also renders
// under a non-cssVariables theme — e.g. a consumer unit test mounted without the
// app ThemeProvider, where `background.neutral` resolves to undefined.

type IconTileProps = Omit<BoxProps, "children"> & {
  icon: string;
  size?: number;
};

export default function IconTile({ icon, size = 96, sx, ...other }: IconTileProps) {
  return (
    <Box
      aria-hidden
      sx={[
        {
          mx: "auto",
          flexShrink: 0,
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 2,
          color: "text.secondary",
          bgcolor: "background.neutral",
          border: "1px solid",
          borderColor: "divider",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...other}
    >
      <Iconify icon={icon} width={Math.round(size / 2)} />
    </Box>
  );
}
