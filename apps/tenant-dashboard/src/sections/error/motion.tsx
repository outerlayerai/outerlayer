"use client";

// Stryker disable all -- Presentational only: framer-motion animation-variant
// data (keyframes, timings, easing) plus a thin motion wrapper. There is no
// branching logic to assert; the only "tests" that would kill these mutants are
// brittle value-pinning of animation numbers, which the project's test-quality
// rules discourage.

import { m, MotionProps, Variants } from "framer-motion";
import Box, { BoxProps } from "@mui/material/Box";

// Children animate in sequence rather than together, so a short stagger reads
// as one settling group instead of a flicker. Exit runs the sequence backwards
// so the element nearest the user's attention leaves last.
const staggerParent: Variants = {
  animate: {
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
  exit: {
    transition: { staggerChildren: 0.06, staggerDirection: -1 },
  },
};

// A single slight overshoot past the resting scale, then settle. The overshoot
// is small enough to read as weight rather than as a bounce, and the whole
// entrance stays under half a second so it never delays reading the page.
export const settleIn: Variants = {
  initial: { opacity: 0, scale: 0.94 },
  animate: {
    opacity: [0, 1, 1],
    scale: [0.94, 1.03, 1],
    transition: {
      duration: 0.42,
      times: [0, 0.55, 1],
      ease: "easeOut",
    },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: 0.2, ease: "easeIn" },
  },
};

export function StaggerContainer({
  children,
  ...other
}: BoxProps & MotionProps) {
  return (
    <Box
      component={m.div}
      initial="initial"
      animate="animate"
      exit="exit"
      variants={staggerParent}
      {...other}
    >
      {children}
    </Box>
  );
}
