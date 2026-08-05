import { styled } from "@mui/material/styles";
import IconButton from "@mui/material/IconButton";

/**
 * 36×36 square-radius chrome icon button (header hamburger + notifications bell).
 *
 * The system's control shape is a 6px-radius square, not MUI's default circle.
 * `open` renders the anchored/active state (a popover is open beneath it).
 * Focus-visible comes from the global CssBaseline ring — never re-declared here.
 */
export const ChromeIconButton = styled(IconButton, {
  shouldForwardProp: (p) => p !== "open",
})<{ open?: boolean }>(({ theme }) => ({
  width: 36,
  height: 36,
  borderRadius: 6,
  color: (theme.vars ?? theme).palette.text.secondary,
  "&:hover": {
    backgroundColor: (theme.vars ?? theme).palette.action.hover,
    color: (theme.vars ?? theme).palette.text.primary,
  },
  variants: [
    {
      props: { open: true },
      style: {
        backgroundColor: (theme.vars ?? theme).palette.background.neutral,
        color: (theme.vars ?? theme).palette.text.primary,
      },
    },
  ],
}));
