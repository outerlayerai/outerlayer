// @vitest-environment jsdom
/**
 * `LocalDate` renders a timestamp only after mount, in the visitor's own
 * timezone. The assertions that matter are therefore about the SERVER output:
 * a date that reaches server-rendered markup is a hydration mismatch waiting
 * for a visitor whose zone differs, so the server render must contain no
 * timestamp at all — and must not consult a locale-reading formatter to decide
 * that.
 */
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RESERVED_CH } from '@/utils/format-date';
import { LocalDate } from '../local-date';

const AT = '2026-07-30T14:45:07Z';

describe('LocalDate', () => {
  it('emits no timestamp in the server render', () => {
    const html = renderToString(<LocalDate value={AT} format="dateTime" />);

    // Nothing month-shaped, nothing clock-shaped, no ISO leaking through.
    expect(html).not.toMatch(/Jul|July|\d{1,2}:\d{2}|2026/);
    expect(html).toContain('local-date-placeholder');
  });

  it('consults no locale-reading formatter while rendering on the server', () => {
    const toLocaleString = vi.spyOn(Date.prototype, 'toLocaleString');
    const toLocaleDateString = vi.spyOn(Date.prototype, 'toLocaleDateString');
    const dateTimeFormat = vi.spyOn(Intl, 'DateTimeFormat');

    renderToString(<LocalDate value={AT} format="dateTime" />);

    expect(toLocaleString).not.toHaveBeenCalled();
    expect(toLocaleDateString).not.toHaveBeenCalled();
    expect(dateTimeFormat).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  /* That the reserved budget is WIDE ENOUGH is asserted against real renderings
   * in the formatter's own suite; this pins only that the placeholder carries
   * the budget for the format it was handed, rather than one fixed width for
   * all of them. */
  it('reserves the budget belonging to its own format', () => {
    expect(renderToString(<LocalDate value={AT} format="monthDay" />)).toContain(
      `min-width:${RESERVED_CH.monthDay}ch`
    );
    expect(renderToString(<LocalDate value={AT} format="numericDateTime" />)).toContain(
      `min-width:${RESERVED_CH.numericDateTime}ch`
    );
    expect(RESERVED_CH.monthDay).not.toBe(RESERVED_CH.numericDateTime);
  });

  it('fills in the formatted value once mounted', () => {
    render(<LocalDate value={AT} format="date" />);
    expect(screen.getByText('Jul 30, 2026')).toBeInTheDocument();
  });

  it('shows the absent mark once mounted when there is no timestamp', () => {
    render(<LocalDate value={null} format="date" absent="-" />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('renders an empty placeholder before mount, not an absent mark', () => {
    // The placeholder carries width and nothing else — an absent mark in the
    // server output would be one more thing for hydration to reconcile.
    const html = renderToString(<LocalDate value={null} format="date" absent="-" />);
    expect(html).toMatch(/><\/span>$/);
  });
});
