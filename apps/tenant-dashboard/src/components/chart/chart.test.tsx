// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider, alpha, createTheme } from '@mui/material/styles';

import { createAppTheme } from '../../theme/create-theme';
import Chart from './chart';

// The global test setup mocks `@/theme` down to default + ThemeProvider, which
// drops `bgBlur` — but chart.tsx's real style fn calls it. Restore the real
// impl so the WHOLE styled() style fn executes exactly as shipped (that is the
// point of rendering the real Chart, not a mock of the seam barrel).
vi.mock('@/theme', async () => {
  const css = await vi.importActual<typeof import('../../theme/css')>('../../theme/css');
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => children,
    ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
    bgBlur: css.bgBlur,
  };
});

// Keep the dynamic ApexChart harmless in jsdom but forward the emotion class to
// a real node so the serialized styles land in the document — the crash class
// lives in the styled() wrapper's style fn, not in the third-party chart.
vi.mock('react-apexcharts', () => ({
  __esModule: true,
  default: (props: { className?: string }) =>
    React.createElement('div', { className: props.className, 'data-testid': 'apexchart' }),
}));

// ----------------------------------------------------------------------

// Return the concatenated cssText of every emitted rule whose selector targets
// `selectorSubstring` — scopes assertions to the Chart's own rules and off the
// theme's `:root` cssVariables block (which legitimately contains other tokens).
function rulesMatching(selectorSubstring: string): string {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll('style'))) {
    if (!el.sheet) continue;
    for (const rule of Array.from(el.sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(selectorSubstring)) {
        out.push(rule.cssText);
      }
    }
  }
  return out.join('');
}

describe('Chart styled wrapper — bare-theme safety (regression)', () => {
  it('does not crash and emits a valid title tint under a bare createTheme (no vars)', async () => {
    // A bare theme has no `theme.vars`, so reading
    // `theme.vars.palette.text.primaryChannel` throws during render (a naive
    // `(theme.vars ?? theme)` fallback would instead emit `rgba(undefined / 0.06)`
    // because `primaryChannel` does not exist on a non-vars palette). Rendering
    // the real styled Chart is what exercises that crash/invalid-color class.
    const { findByTestId } = render(
      <ThemeProvider theme={createTheme()}>
        <Chart type="line" series={[]} options={{}} height={100} />
      </ThemeProvider>,
    );
    // The dynamic (ssr:false) inner chart mounts a tick after the styled wrapper;
    // awaiting it proves the real Chart rendered end-to-end without throwing.
    const inner = await findByTestId('apexchart');
    expect(inner.tagName).toBe('DIV');

    const titleRule = rulesMatching('apexcharts-tooltip-title');
    // The fallback resolves to a concrete alpha of the default ink, not `undefined`.
    const expected = alpha(createTheme().palette.text.primary, 0.06);
    expect(expected).toBe('rgba(0, 0, 0, 0.06)');
    expect(titleRule).toContain(`background-color: ${expected}`);
    expect(titleRule).not.toContain('undefined');
  });

  it('emits the channel-var tint under the app vars theme', async () => {
    const { findByTestId } = render(
      <ThemeProvider theme={createAppTheme()}>
        <Chart type="line" series={[]} options={{}} height={100} />
      </ThemeProvider>,
    );
    const inner = await findByTestId('apexchart');
    expect(inner.tagName).toBe('DIV');

    const titleRule = rulesMatching('apexcharts-tooltip-title');
    // Under the vars theme the tint tracks the color scheme via the channel var.
    expect(titleRule).toContain('rgba(var(--mui-palette-text-primaryChannel) / 0.06)');
    expect(titleRule).not.toContain('undefined');
  });
});
