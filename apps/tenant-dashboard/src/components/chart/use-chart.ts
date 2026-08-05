import merge from 'lodash/merge';
import { ApexOptions } from 'apexcharts';

import { useColorScheme, useTheme, type Palette } from '@mui/material/styles';
import { VIZ, type SchemeMode, type VizScheme } from '@repo/design-tokens';

import { useResponsive } from '../../hooks/use-responsive';

// ----------------------------------------------------------------------

/**
 * Resolve the ACTIVE color scheme's literal palette plus the matching viz
 * slots. Under cssVariables, `theme.palette` is statically the LIGHT scheme,
 * and ApexCharts needs literal color strings (it computes shades in JS;
 * `var(--…)` breaks it) — so chart code reads scheme-true literals from here
 * and re-renders on scheme change. Falls back to `theme.palette` when the
 * theme has no color schemes (a bare `createTheme`, e.g. in tests).
 */
export function useChartScheme(): { palette: Palette; viz: VizScheme; mode: SchemeMode } {
  const theme = useTheme();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode: SchemeMode = ((mode === 'system' ? systemMode : mode) ?? 'light') as SchemeMode;
  const palette: Palette = theme.colorSchemes?.[resolvedMode]?.palette ?? theme.palette;
  return { palette, viz: VIZ[resolvedMode], mode: resolvedMode };
}

/**
 * Base chart language: straight 2px lines, flat washes (no gradient fades),
 * hairline solid grid, visible baseline, mono figures, restrained legend.
 * Series identity comes from the validated fixed-order categorical slots —
 * callers encoding percentiles pass `viz.ordinal` steps instead, and
 * status-meaning series (pass/fail) pass semantic colors.
 */
export default function useChart(options?: ApexOptions): ApexOptions {
  const theme = useTheme();
  const { palette, viz } = useChartScheme();
  const smUp = useResponsive('up', 'sm');

  const baseOptions: ApexOptions = {
    colors: [...viz.categorical],

    chart: {
      toolbar: { show: false },
      zoom: { enabled: false },
      foreColor: palette.text.disabled,
      // Mono everywhere chart chrome renders text (ticks, legend, tooltip) —
      // figures read as instrument output, matching the tile/panel labels.
      fontFamily: theme.typography.fontFamilyMonospace,
    },

    states: {
      hover: { filter: { type: 'lighten', value: 0.04 } },
      active: { filter: { type: 'darken', value: 0.88 } },
    },

    fill: { opacity: 1, type: 'solid' },

    dataLabels: { enabled: false },

    stroke: { width: 2, curve: 'straight', lineCap: 'round' },

    grid: {
      // Hairline, solid, recessive — never dashed.
      strokeDashArray: 0,
      borderColor: viz.grid,
      xaxis: { lines: { show: false } },
    },

    xaxis: {
      // The baseline is the one emphasized rule of the plot.
      axisBorder: { show: true, color: viz.baseline },
      axisTicks: { show: false },
      labels: { style: { fontSize: '10px' } },
    },

    yaxis: {
      labels: { style: { fontSize: '10px' } },
    },

    markers: {
      size: 0,
      strokeColors: palette.background.paper,
      strokeWidth: 2,
      hover: { size: 5 },
    },

    tooltip: {
      x: { show: true },
    },

    legend: {
      // A single series needs no legend — the panel title names it.
      show: true,
      showForSingleSeries: false,
      fontSize: '11px',
      fontWeight: 600,
      position: 'top',
      horizontalAlign: 'right',
      markers: { size: 5, shape: 'square' },
      itemMargin: { horizontal: 8 },
      labels: { colors: palette.text.secondary },
    },

    plotOptions: {
      bar: {
        // 4px rounded data-end, square at the baseline.
        borderRadius: smUp ? 4 : 2,
        columnWidth: '40%',
        borderRadiusApplication: 'end',
        borderRadiusWhenStacked: 'last',
      },
    },
  };

  // Deep merge so a caller's partial override (e.g. `plotOptions.bar.borderRadius`)
  // patches the base without dropping sibling defaults; the caller wins per key.
  return merge(baseOptions, options);
}
