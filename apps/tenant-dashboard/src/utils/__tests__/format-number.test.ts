import { describe, expect, it, vi } from 'vitest';

import { fCurrency, fNumber } from '../format-number';

describe('fNumber', () => {
  /* The ambient locale differs between the SSR process and the visitor's
   * browser, so a formatter that consults it produces different markup on each
   * side and React reports a hydration mismatch. Stubbing the built-in to a
   * sentinel is what makes that observable: asserting on "1,234,567" alone
   * would also pass under an en-US ambient locale, proving nothing. */
  it('groups without consulting the ambient locale', () => {
    const ambient = vi
      .spyOn(Number.prototype, 'toLocaleString')
      .mockReturnValue('AMBIENT_LOCALE');

    expect(fNumber(1234567)).toBe('1,234,567');
    expect(fNumber(1234.5, true)).toBe('1,234.5');
    expect(ambient).not.toHaveBeenCalled();

    ambient.mockRestore();
  });

  it('returns empty string for null/empty input', () => {
    expect(fNumber(null)).toBe('');
    expect(fNumber('')).toBe('');
  });
});

describe('fCurrency', () => {
  it('formats normal values at the requested precision', () => {
    expect(fCurrency(1234.56, 2)).toBe('$1,234.56');
    expect(fCurrency(0.01234, 5)).toBe('$0.01234');
  });

  it('strips trailing zeros for whole numbers', () => {
    expect(fCurrency(42, 2)).toBe('$42');
    expect(fCurrency(1000, 2)).toBe('$1,000');
  });

  it('returns $0 only for an actual zero', () => {
    expect(fCurrency(0, 5)).toBe('$0');
    expect(fCurrency(0, 6)).toBe('$0');
  });

  it('shows tiny non-zero values at their natural precision instead of $0', () => {
    expect(fCurrency(0.0000001, 6)).toBe('$0.0000001');
    expect(fCurrency(0.000045, 2)).toBe('$0.000045');
    expect(fCurrency(0.00000012, 6)).toBe('$0.00000012');
    expect(fCurrency(0.0000003, 5)).toBe('$0.0000003');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(fCurrency(null)).toBe('');
    expect(fCurrency('')).toBe('');
  });
});
