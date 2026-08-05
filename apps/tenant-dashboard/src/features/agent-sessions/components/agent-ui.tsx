"use client";

/**
 * Box-based `Stack` shim. MUI's OverridableComponent-typed Stack trips the
 * React-19 overload-resolution bug (TS2769) in these files; Box doesn't. Same
 * API surface we use (direction/spacing/alignItems/justifyContent/flexWrap),
 * spacing in theme units via `gap`. One definition, imported by all agent
 * sections.
 */
import { Box, type BoxProps } from "@mui/material";

interface StackProps extends Omit<BoxProps, "direction"> {
  direction?: "row" | "column";
  spacing?: number;
  alignItems?: string;
  justifyContent?: string;
  flexWrap?: "wrap" | "nowrap";
  /** Accepted for API-compat with MUI Stack; a no-op (gap already applies). */
  useFlexGap?: boolean;
}

export function Stack({ direction = "column", spacing = 0, alignItems, justifyContent, flexWrap, useFlexGap: _useFlexGap, sx, children, ...rest }: StackProps) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: direction,
        gap: spacing,
        ...(alignItems ? { alignItems } : {}),
        ...(justifyContent ? { justifyContent } : {}),
        ...(flexWrap ? { flexWrap } : {}),
        ...sx,
      }}
      {...rest}
    >
      {children}
    </Box>
  );
}
