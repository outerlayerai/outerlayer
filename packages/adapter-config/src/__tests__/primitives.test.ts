import { describe, expect, it } from 'vitest';
import {
  firstNonEmpty,
  parseEnvBoolean,
  resolveNeutralValue,
} from '../primitives';

describe('parseEnvBoolean', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['  On  ', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['OFF', false],
    ['', false],
    ['   ', false],
  ])('parses %j -> %j', (input, expected) => {
    expect(parseEnvBoolean(input)).toBe(expected);
  });

  it.each(['maybe', '2', 'truthy', 'enabled', 'y'])(
    'returns undefined for unrecognised value %j',
    (input) => {
      expect(parseEnvBoolean(input)).toBeUndefined();
    }
  );

  it('returns undefined (not false) for undefined input', () => {
    expect(parseEnvBoolean(undefined)).toBeUndefined();
  });
});

describe('firstNonEmpty', () => {
  it('returns the first non-empty value, trimmed', () => {
    expect(firstNonEmpty(undefined, '  ', 'second', 'third')).toBe('second');
  });

  it('skips whitespace-only values', () => {
    expect(firstNonEmpty('', '   ', '\t', 'real')).toBe('real');
  });

  it('preserves order (earlier wins)', () => {
    expect(firstNonEmpty('a', 'b')).toBe('a');
  });

  it('returns undefined when everything is empty or undefined', () => {
    expect(firstNonEmpty(undefined, '', '   ')).toBeUndefined();
  });

  it('returns undefined for no arguments', () => {
    expect(firstNonEmpty()).toBeUndefined();
  });
});

describe('resolveNeutralValue', () => {
  it('prefers a neutral value and flags usedLegacy=false', () => {
    expect(
      resolveNeutralValue({ neutral: ['neutral-dsn'], legacy: ['legacy-dsn'] })
    ).toEqual({ value: 'neutral-dsn', usedLegacy: false });
  });

  it('falls back to legacy only when every neutral name is empty', () => {
    expect(
      resolveNeutralValue({ neutral: [undefined, '  '], legacy: ['legacy-dsn'] })
    ).toEqual({ value: 'legacy-dsn', usedLegacy: true });
  });

  it('trims the legacy value too', () => {
    expect(
      resolveNeutralValue({ neutral: [], legacy: ['  legacy-dsn  '] })
    ).toEqual({ value: 'legacy-dsn', usedLegacy: true });
  });

  it('a present neutral value wins even with a legacy present (no legacy flag)', () => {
    expect(
      resolveNeutralValue({ neutral: ['n'], legacy: ['l'] }).usedLegacy
    ).toBe(false);
  });

  it('returns no value and usedLegacy=false when nothing is set', () => {
    expect(
      resolveNeutralValue({ neutral: [undefined], legacy: [undefined] })
    ).toEqual({ value: undefined, usedLegacy: false });
  });

  it('treats a missing legacy list as empty', () => {
    expect(resolveNeutralValue({ neutral: [undefined] })).toEqual({
      value: undefined,
      usedLegacy: false,
    });
  });
});
