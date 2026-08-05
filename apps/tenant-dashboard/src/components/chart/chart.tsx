'use client';

import { memo } from 'react';
import dynamic from 'next/dynamic';

import { alpha, styled } from '@mui/material/styles';

import { bgBlur } from '@/theme';

// ----------------------------------------------------------------------

// `react-apexcharts` pulls in `apexcharts`, which reads `window` at module load.
// A static import evaluates that on the server during SSR and throws
// `window is not defined`, failing the page's Suspense boundary and surfacing as
// React error #419 in Sentry. Load it lazily, client-only, so the server never
// touches the module.
const ApexChart = dynamic(() => import('react-apexcharts'), { ssr: false });

// The wrapper only ever renders on the client under the app's cssVariables
// theme, so `theme.vars` and the channel tokens are always present here. CSS
// (unlike the JS-computed series colors in `useChart`) can use `var(--…)`, so
// the chrome tracks the color scheme via `theme.vars` + `applyStyles('dark')` —
// no `palette.mode` branch.
const Chart = styled(ApexChart)(({ theme }) => ({
  '& .apexcharts-canvas': {
    // Tooltip
    '& .apexcharts-tooltip': {
      ...bgBlur({
        color: theme.palette.background.default,
        colorChannel: theme.vars?.palette.background.defaultChannel,
      }),
      color: (theme.vars ?? theme).palette.text.primary,
      boxShadow: theme.shadows[8],
      borderRadius: Number(theme.shape.borderRadius) * 1.25,
      '&.apexcharts-theme-light': {
        borderColor: 'transparent',
        ...bgBlur({
          color: theme.palette.background.default,
          colorChannel: theme.vars?.palette.background.defaultChannel,
        }),
      },
    },
    '& .apexcharts-xaxistooltip': {
      ...bgBlur({
        color: theme.palette.background.default,
        colorChannel: theme.vars?.palette.background.defaultChannel,
      }),
      borderColor: 'transparent',
      color: (theme.vars ?? theme).palette.text.primary,
      boxShadow: theme.shadows[8],
      borderRadius: Number(theme.shape.borderRadius) * 1.25,
      '&::before': { borderBottomColor: (theme.vars ?? theme).palette.divider },
      '&::after': { borderBottomColor: (theme.vars ?? theme).palette.background.default },
    },
    '& .apexcharts-tooltip-title': {
      textAlign: 'center',
      fontWeight: theme.typography.fontWeightBold,
      // Faint ink wash to set the title band apart, via the primary-ink channel
      // token so it reads at the same strength in both schemes. Falls back to
      // `alpha` under a bare (non-vars) theme, where `primaryChannel` is absent.
      backgroundColor: theme.vars
        ? `rgba(${theme.vars.palette.text.primaryChannel} / 0.06)`
        : alpha(theme.palette.text.primary, 0.06),
      color: (theme.vars ?? theme).palette.text.secondary,
      ...theme.applyStyles('dark', {
        color: (theme.vars ?? theme).palette.text.primary,
      }),
    },

    // Legend
    '& .apexcharts-legend': {
      padding: 0,
    },
    '& .apexcharts-legend-series': {
      display: 'inline-flex !important',
      alignItems: 'center',
    },
    '& .apexcharts-legend-marker': {
      marginRight: 8,
    },
    '& .apexcharts-legend-text': {
      lineHeight: '18px',
      textTransform: 'capitalize',
    },
  },
}));

export default memo(Chart);
