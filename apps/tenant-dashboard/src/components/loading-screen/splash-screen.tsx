"use client";

import { m } from "framer-motion";
import { useState, useEffect } from "react";

import Box, { BoxProps } from "@mui/material/Box";

import Logo from "@/components/logo";

// ----------------------------------------------------------------------

// Full-viewport branded fallback shown while a guard resolves auth/tenant
// state. Mount is gated so the animated mark never flashes during SSR
// hydration.
export default function SplashScreen({ sx, ...other }: BoxProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <Box
      sx={{
        right: 0,
        bottom: 0,
        width: 1,
        height: 1,
        zIndex: 9998,
        display: "flex",
        position: "absolute",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
        ...sx,
      }}
      {...other}
    >
      <Box
        component={m.div}
        animate={{ scale: [1, 0.92, 1], opacity: [1, 0.5, 1] }}
        transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
      >
        <Logo disabledLink sx={{ width: 64, height: 64 }} />
      </Box>
    </Box>
  );
}
