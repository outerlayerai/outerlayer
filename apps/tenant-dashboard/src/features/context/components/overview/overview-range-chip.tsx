"use client";

/**
 * The Overview's time-range control — the dashboards' mono-chip + popover
 * idiom, writing to the URL through the caller so the range is shareable.
 */
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import CustomPopover, { usePopover } from "@/components/custom-popover";
import { useTranslate } from "@outerlayer/locales";
import type { ContextOverviewRange } from "../../types";

const RANGES: ContextOverviewRange[] = ["24h", "7d", "30d", "90d"];

export function OverviewRangeChip({
  range,
  onChange,
}: {
  range: ContextOverviewRange;
  onChange: (range: ContextOverviewRange) => void;
}) {
  const { t } = useTranslate();
  const popover = usePopover();
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        color="inherit"
        onClick={popover.onOpen}
        data-testid="overview-range-chip"
        sx={{
          fontFamily: (theme: { typography: { fontFamilyMonospace: string } }) =>
            theme.typography.fontFamilyMonospace,
          fontSize: 12,
        }}
      >
        {t("dashboard.context.overview.rangeChip", {
          range: t(`dashboard.context.overview.range.${range}`),
        })}
      </Button>
      <CustomPopover open={popover.open} onClose={popover.onClose}>
        {RANGES.map((value) => (
          <MenuItem
            key={value}
            selected={value === range}
            data-testid={`overview-range-${value}`}
            onClick={() => {
              onChange(value);
              popover.onClose();
            }}
          >
            {t("dashboard.context.overview.rangeChip", {
              range: t(`dashboard.context.overview.range.${value}`),
            })}
          </MenuItem>
        ))}
      </CustomPopover>
    </>
  );
}
