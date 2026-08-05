"use client";

/**
 * Shared presentation pieces for the context adoption surfaces (tree
 * annotations and the Usage tabs): the relative last-used time, the "never"
 * exception mark, the stat headline, the zero-filled trend sparkline, and
 * the session-link row. Plain SVG polyline, not a chart library — cheap
 * enough to render per pane, and the zero-fill keeps a long-silent artifact
 * looking silent.
 */
import type { ReactNode } from "react";
import Link from "@mui/material/Link";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTranslate } from "@outerlayer/locales";
import { RouterLink } from "../../../routes/components";
import { parseAdoptionTimestamp, relativeTimeParts } from "./adoption-time";

const SPARK_H = 36;
const SPARK_PAD = 3;

/** Full local date-time for the relative-time tooltip. Formats inline rather
 * than through `LocalDate` because a tooltip title is a string, and it needs no
 * after-mount guard: tooltip content is absent from the DOM until hover, so it
 * never reaches server-rendered markup and cannot hydrate into a mismatch. */
const fmtAdoptionDateTime = (raw: string | null): string => {
  const ms = parseAdoptionTimestamp(raw);
  return ms === null ? "" : new Date(ms).toLocaleString();
};

const REL_TIME_KEY = {
  now: "dashboard.context.tree.relTimeNow",
  minutes: "dashboard.context.tree.relTimeMinutes",
  hours: "dashboard.context.tree.relTimeHours",
  days: "dashboard.context.tree.relTimeDays",
} as const;

/**
 * Translated "2h ago"-style label for a last-used timestamp, or `null` when
 * the timestamp is absent — the caller renders nothing rather than a fake time.
 */
export function useRelativeTimeLabel(): (raw: string | null) => string | null {
  const { t } = useTranslate();
  return (raw) => {
    const parts = relativeTimeParts(raw, Date.now());
    return parts === null ? null : t(REL_TIME_KEY[parts.unit], { count: parts.count });
  };
}

/**
 * Muted right-slot relative time — the healthy-row annotation. Faint grey,
 * tabular numerals, absolute date in the tooltip. Renders nothing without a
 * parseable timestamp (unknown stays invisible).
 */
export function RelativeTimeText({
  value,
  testId,
  sx,
}: {
  value: string | null;
  testId: string;
  sx?: SxProps<Theme>;
}) {
  const label = useRelativeTimeLabel()(value);
  if (label === null) return null;
  return (
    <Tooltip title={fmtAdoptionDateTime(value)}>
      <Typography
        component="span"
        variant="caption"
        data-testid={testId}
        sx={{
          color: "text.disabled",
          flexShrink: 0,
          fontVariantNumeric: "tabular-nums",
          ...sx,
        }}
      >
        {label}
      </Typography>
    </Tooltip>
  );
}

/** The one exception state that earns color: red-tinted, 600-weight "never". */
export function NeverUsedText({ tip, testId }: { tip: string; testId: string }) {
  const { t } = useTranslate();
  return (
    <Tooltip title={tip}>
      <Typography
        component="span"
        variant="caption"
        data-testid={testId}
        sx={{ color: "error.main", fontWeight: 600, flexShrink: 0 }}
      >
        {t("dashboard.context.tree.lastUsedNever")}
      </Typography>
    </Tooltip>
  );
}

/** One figure of the Usage tab's stat headline: big number over a muted label. */
export function AdoptionStat({
  value,
  label,
  testId,
}: {
  value: React.ReactNode;
  label: string;
  testId?: string;
}) {
  return (
    <Box {...(testId ? { "data-testid": testId } : {})}>
      <Typography sx={{ fontSize: 19, fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
        {value}
      </Typography>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}
      >
        {label}
      </Typography>
    </Box>
  );
}

export function TrendSparkline({
  series,
  unit,
  width = 220,
}: {
  series: number[];
  unit: string;
  /** Drawing width in px — the tree drill-down default, or wider for the Usage tab. */
  width?: number;
}) {
  const max = Math.max(...series);
  if (series.length < 2 || max === 0) {
    return (
      <Box
        component="svg"
        width={width}
        height={SPARK_H}
        viewBox={`0 0 ${width} ${SPARK_H}`}
        role="img"
        aria-label={`No ${unit} in the window`}
        data-testid="adoption-sparkline-flat"
        sx={{ display: "block", color: "text.disabled", maxWidth: 1 }}
      >
        <line
          x1={SPARK_PAD}
          y1={SPARK_H / 2}
          x2={width - SPARK_PAD}
          y2={SPARK_H / 2}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </Box>
    );
  }
  const n = series.length;
  const xAt = (i: number) => SPARK_PAD + (i / (n - 1)) * (width - 2 * SPARK_PAD);
  const yAt = (v: number) => SPARK_H - SPARK_PAD - (v / max) * (SPARK_H - 2 * SPARK_PAD);
  const line = series.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  return (
    <Box
      component="svg"
      width={width}
      height={SPARK_H}
      viewBox={`0 0 ${width} ${SPARK_H}`}
      role="img"
      aria-label={`Peak ${max} ${unit}/day`}
      data-testid="adoption-sparkline"
      sx={{ display: "block", color: "primary.main", maxWidth: 1 }}
    >
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </Box>
  );
}

export function AdoptionSessionRow({
  label,
  suffix,
  href,
}: {
  label: string;
  suffix: ReactNode;
  href: string;
}) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", minWidth: 0 }}>
      <Link
        component={RouterLink}
        href={href}
        variant="caption"
        data-testid="adoption-session-link"
        sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </Link>
      <Typography variant="caption" sx={{ color: "text.disabled", flexShrink: 0 }}>
        {suffix}
      </Typography>
    </Stack>
  );
}
