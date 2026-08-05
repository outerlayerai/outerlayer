// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ApexOptions } from 'apexcharts';
import { ThemeProvider, createTheme, type Theme } from '@mui/material/styles';

import { createAppTheme } from '../../theme/create-theme';
import useChart from './use-chart';

// ----------------------------------------------------------------------

function renderChart(options: ApexOptions | undefined, theme: Theme, mode?: 'light' | 'dark') {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider theme={theme} defaultMode={mode}>
      {children}
    </ThemeProvider>
  );
  Wrapper.displayName = 'ChartTestWrapper';
  return renderHook(() => useChart(options), { wrapper: Wrapper }).result;
}

describe('useChart base defaults', () => {
  it('emits the observable chrome defaults consumers rely on', () => {
    const theme = createAppTheme();
    const result = renderChart(undefined, theme, 'light');

    expect(result.current.chart?.toolbar?.show).toBe(false);
    expect(result.current.chart?.zoom?.enabled).toBe(false);
    expect(result.current.dataLabels?.enabled).toBe(false);
    expect(result.current.grid?.xaxis?.lines?.show).toBe(false);
    // A single series carries no legend box — the panel title names it.
    expect(result.current.legend?.showForSingleSeries).toBe(false);
    // Grid is a solid hairline, lines are straight 2px — the chart language
    // bans dashed grids, smoothed splines, and gradient fades outright.
    expect(result.current.grid?.strokeDashArray).toBe(0);
    expect(result.current.stroke).toEqual({ width: 2, curve: 'straight', lineCap: 'round' });
    expect(result.current.fill).toEqual({ opacity: 1, type: 'solid' });
    // Slot 1 of the validated categorical palette is the brand blue, and the
    // slot order is fixed (it is the colorblind-safety mechanism).
    expect(result.current.colors?.[0]).toBe('#2065D1');
    expect(result.current.colors?.[0]).toBe(theme.colorSchemes.light!.palette.primary.main);
  });

  it('pins the axis, marker, and legend chrome exactly', () => {
    const theme = createAppTheme();
    const result = renderChart(undefined, theme, 'light');

    // The baseline is the one emphasized rule of the plot; ticks are hidden
    // and tick labels are 10px mono (the font comes from chart.fontFamily).
    expect(result.current.xaxis).toEqual({
      axisBorder: { show: true, color: '#D5D5D0' },
      axisTicks: { show: false },
      labels: { style: { fontSize: '10px' } },
    });
    expect(result.current.yaxis).toEqual({
      labels: { style: { fontSize: '10px' } },
    });
    expect(result.current.grid?.borderColor).toBe('#F0F0ED');
    expect(result.current.chart?.fontFamily).toBe(theme.typography.fontFamilyMonospace);

    // Point markers rest invisible, surface-ringed, and grow on hover so the
    // crosshair layer has a target.
    expect(result.current.markers).toEqual({
      size: 0,
      strokeColors: theme.colorSchemes.light!.palette.background.paper,
      strokeWidth: 2,
      hover: { size: 5 },
    });

    // Square legend swatches with the compact mono-scaled text treatment.
    expect(result.current.legend).toEqual({
      show: true,
      showForSingleSeries: false,
      fontSize: '11px',
      fontWeight: 600,
      position: 'top',
      horizontalAlign: 'right',
      markers: { size: 5, shape: 'square' },
      itemMargin: { horizontal: 8 },
      labels: { colors: theme.colorSchemes.light!.palette.text.secondary },
    });

    // Hover/active state filters and the shared-x tooltip base are part of
    // the contract too — Apex silently drops interactivity if they vanish.
    expect(result.current.states).toEqual({
      hover: { filter: { type: 'lighten', value: 0.04 } },
      active: { filter: { type: 'darken', value: 0.88 } },
    });
    expect(result.current.tooltip).toEqual({ x: { show: true } });
  });
});

describe('useChart merge semantics', () => {
  it('deep-merges a nested caller override without dropping sibling defaults', () => {
    const result = renderChart(
      { plotOptions: { bar: { borderRadius: 2 } } },
      createAppTheme(),
      'light',
    );

    // borderRadius is the caller's; the sibling bar defaults survive the merge
    // (a shallow merge would have replaced the whole `bar` object).
    expect(result.current.plotOptions?.bar).toEqual({
      borderRadius: 2,
      columnWidth: '40%',
      borderRadiusApplication: 'end',
      borderRadiusWhenStacked: 'last',
    });
  });

  it('preserves a per-series array override verbatim alongside base stroke keys', () => {
    const result = renderChart({ stroke: { width: [2, 0] } }, createAppTheme(), 'light');

    expect(result.current.stroke).toEqual({
      width: [2, 0],
      curve: 'straight',
      lineCap: 'round',
    });
  });
});

describe('useChart scheme resolution', () => {
  it('resolves the DARK scheme literals under a dark color scheme', () => {
    const theme = createAppTheme();
    const result = renderChart(undefined, theme, 'dark');

    // The dark-mode fix: literal colors track the active scheme, not the static
    // light palette.
    expect(result.current.colors?.[0]).toBe('#4C8DEE');
    expect(result.current.colors?.[0]).toBe(theme.colorSchemes.dark!.palette.primary.main);
    expect(result.current.colors?.[0]).not.toBe(theme.colorSchemes.light!.palette.primary.main);

    expect(result.current.chart?.foreColor).toBe('#6B6B64');
    expect(result.current.chart?.foreColor).toBe(theme.colorSchemes.dark!.palette.text.disabled);
    expect(result.current.chart?.foreColor).not.toBe(
      theme.colorSchemes.light!.palette.text.disabled,
    );
  });

  it('falls back to theme.palette under a bare createTheme (no color schemes)', () => {
    const bare = createTheme();
    const result = renderChart(undefined, bare);

    // No colorSchemes → chrome colors come from theme.palette (light) without
    // crashing; series colors are the light viz slots (they never derive from
    // an arbitrary theme's palette).
    expect(result.current.colors?.[0]).toBe('#2065D1');
    expect(result.current.chart?.foreColor).toBe(bare.palette.text.disabled);
  });
});
