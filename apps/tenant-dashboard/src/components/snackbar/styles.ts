import { MaterialDesignContent } from "notistack";

import { styled, alpha } from "@mui/material/styles";

// ----------------------------------------------------------------------

type SnackbarVariantColor = "info" | "success" | "warning" | "error";

// `theme.vars` exists only when cssVariables is enabled (the app theme); fall
// back to `theme` so these styles also render under a plain (test) theme.
// Scheme-dependent colors flip via `theme.applyStyles('dark', …)` — never a
// static `theme.palette.mode` branch, which cssVariables freezes at build time.

export const StyledNotistack = styled(MaterialDesignContent)(({ theme }) => {
  const vars = theme.vars ?? theme;

  return {
    "& #notistack-snackbar": {
      ...theme.typography.subtitle2,
      padding: 0,
      flexGrow: 1,
    },
    "&.notistack-MuiContent": {
      color: vars.palette.text.primary,
      padding: theme.spacing(0.5, 2, 0.5, 0.5),
      borderRadius: theme.shape.borderRadius,
      boxShadow: theme.shadows[8],
      backgroundColor: vars.palette.background.paper,
    },
    // The neutral (variant-less) toast is inverted for contrast: dark surface in
    // light mode, light surface in dark mode.
    "&.notistack-MuiContent-default": {
      padding: theme.spacing(1, 2, 1, 1),
      color: vars.palette.common.white,
      backgroundColor: vars.palette.grey[800],
      ...theme.applyStyles("dark", {
        color: vars.palette.grey[800],
        backgroundColor: vars.palette.common.white,
      }),
    },
  };
});

// ----------------------------------------------------------------------

type StyledIconProps = {
  color: SnackbarVariantColor;
};

export const StyledIcon = styled("span")<StyledIconProps>(({ color, theme }) => ({
  width: 40,
  height: 40,
  display: "flex",
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "center",
  marginRight: theme.spacing(1.5),
  borderRadius: theme.shape.borderRadius,
  color: (theme.vars ?? theme).palette[color].main,
  backgroundColor: theme.vars
    ? `rgba(${theme.vars.palette[color].mainChannel} / 0.16)`
    : alpha(theme.palette[color].main, 0.16),
}));
