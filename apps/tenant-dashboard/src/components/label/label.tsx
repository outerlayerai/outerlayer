import { forwardRef } from "react";

import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";

import { LabelProps } from "./types";
import { getLabelStyles } from "./styles";

// ----------------------------------------------------------------------

const Label = forwardRef<HTMLSpanElement, LabelProps>(function Label(
  { children, color = "default", variant = "soft", startIcon, sx, ...other },
  ref,
) {
  const theme = useTheme();

  // Icon glyph box: spacing(2) (16px) — between the caption cap height (12px)
  // and the pill height (24px) so the mark reads clearly without crowding.
  const iconBox = theme.spacing(2);

  return (
    <Box
      ref={ref}
      component="span"
      sx={[
        getLabelStyles(theme, color, variant),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...other}
    >
      {startIcon && (
        <Box
          component="span"
          sx={{
            mr: 0.75,
            width: iconBox,
            height: iconBox,
            "& svg, & img": { width: 1, height: 1, objectFit: "cover" },
          }}
        >
          {startIcon}
        </Box>
      )}

      {children}
    </Box>
  );
});

Label.displayName = "Label";

export default Label;
