import { alpha } from "@mui/material/styles";
import type { CSSObject } from "@mui/material/styles";

// ----------------------------------------------------------------------

type BgBlurProps = {
  color?: string;
  // A MUI channel var (e.g. theme.vars.palette.background.defaultChannel) makes
  // the tint switch with the color scheme; `color` alone is baked to one scheme.
  colorChannel?: string;
  blur?: number;
  opacity?: number;
};

export function bgBlur(props?: BgBlurProps): CSSObject {
  const blur = props?.blur ?? 6;
  const opacity = props?.opacity ?? 0.8;
  const backgroundColor = props?.colorChannel
    ? `rgba(${props.colorChannel} / ${opacity})`
    : alpha(props?.color ?? "#000000", opacity);

  return {
    backdropFilter: `blur(${blur}px)`,
    WebkitBackdropFilter: `blur(${blur}px)`,
    backgroundColor,
  };
}
