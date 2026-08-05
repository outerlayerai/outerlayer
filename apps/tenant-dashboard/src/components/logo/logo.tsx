import { forwardRef } from "react";

import Link from "@mui/material/Link";
import Box, { BoxProps } from "@mui/material/Box";

import { RouterLink } from "../../routes/components";

// ----------------------------------------------------------------------

interface LogoProps extends BoxProps {
  // Render the mark on its own, without the home-link wrapper (e.g. inside the
  // splash screen, which is not a navigable surface).
  disabledLink?: boolean;
  // Render the full wordmark instead of the square mark (e.g. the expanded nav
  // rail). Sized by height; width follows the artwork's aspect ratio.
  full?: boolean;
}

const Logo = forwardRef<HTMLDivElement, LogoProps>(function Logo(
  { disabledLink = false, full = false, sx, ...other },
  ref,
) {
  const mark = (
    <Box
      ref={ref}
      component="img"
      alt="OuterLayer"
      src={
        full
          ? "/assets/outerlayer-full-logo.svg"
          : "/assets/outerlayer-logo.svg"
      }
      sx={{
        display: "inline-flex",
        ...(full ? { height: 34, width: "auto" } : { width: 42, height: 42 }),
        ...sx,
      }}
      {...other}
    />
  );

  if (disabledLink) {
    return mark;
  }

  return (
    <Link component={RouterLink} href="/" sx={{ display: "contents" }}>
      {mark}
    </Link>
  );
});

Logo.displayName = "Logo";

export default Logo;
