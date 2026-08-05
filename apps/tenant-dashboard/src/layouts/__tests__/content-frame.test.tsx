// @vitest-environment jsdom
/**
 * Tests for `<LayoutMain>` — the shared content frame.
 *
 * Pins the frame's contract: the readable column is capped at
 * `CONTENT.MAX_WIDTH` (1600px) rather than a hardcoded `!important` width, and
 * the frame is a `<main>` landmark offset below the fixed 56px header so page
 * content never hides under it.
 *
 * The `lg`-only rail reservation (`ml`) is NOT unit-tested: jsdom's matchMedia
 * is always false, so the breakpoint branch never applies here — visual QA
 * covers it. Faking matchMedia to assert an sx breakpoint would test the mock.
 */

import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import { LayoutMain } from '../content-frame';

function renderFrame(railWidth?: number) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <LayoutMain railWidth={railWidth}>
        <div data-testid="page-child" />
      </LayoutMain>
    </ThemeProvider>,
  );
}

describe('LayoutMain — content frame', () => {
  it('offsets a <main> landmark below the fixed 56px header', () => {
    renderFrame();
    const main = screen.getByRole('main');
    expect(main).toHaveStyle({ paddingTop: '56px' });
  });

  it('caps the readable column at 1600px', () => {
    renderFrame();
    const inner = screen.getByTestId('page-child').parentElement as HTMLElement;
    expect(inner).toHaveStyle({ maxWidth: '1600px' });
  });
});
