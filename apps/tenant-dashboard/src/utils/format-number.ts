import numeral from 'numeral';

// ----------------------------------------------------------------------

type InputValue = string | number | null;

function isValidNumber(value: InputValue): boolean {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Grouped integer/decimal display. `numeral`'s format is locale-independent —
 * always `,` groups and `.` decimals — which is what makes this safe to render
 * during SSR. `toLocaleString()` with no locale resolves against the ambient
 * one (the server's ICU default, then the browser's), so a visitor whose
 * grouping separator differs from the server's gets a hydration mismatch.
 * Prefer this over the built-in for any number that reaches server-rendered
 * markup.
 */
export function fNumber(number: InputValue, showDecimals: boolean = false) {
  if (showDecimals) {
    const format = isValidNumber(number) ? numeral(number).format('0,0.[00]') : '';
    return result(format, '.[00]');
  }
  
  return isValidNumber(number) ? numeral(number).format() : '';
}

export function fCurrency(number: InputValue, fractionDigits: number = 2) {
  if (!isValidNumber(number)) return '';

  const n = Number(number);

  // Auto-extend precision for tiny non-zero values that would otherwise round
  // to "$0" at the configured fractionDigits — e.g. $0.0000003 at 6 decimals.
  // Falls back to 2-significant-digit display so the real value is always visible.
  if (n !== 0 && Math.abs(n) < 10 ** -fractionDigits) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumSignificantDigits: 1,
      maximumSignificantDigits: 2,
    }).format(n);
  }

  const fractionFormat = `.${'0'.repeat(fractionDigits)}`;
  const format = numeral(n).format(`$0,0${fractionFormat}`);
  return result(format, fractionFormat);
}



export function fShortenNumber(number: InputValue) {
  const format = isValidNumber(number) ? numeral(number).format('0.00a') : '';

  return result(format, '.00');
}

export function fData(number: InputValue) {
  const format = isValidNumber(number) ? numeral(number).format('0.0 b') : '';

  return result(format, '.0');
}

function result(format: string, key = '.00') {
  const isInteger = format.includes(key);

  return isInteger ? format.replace(key, '') : format;
}
