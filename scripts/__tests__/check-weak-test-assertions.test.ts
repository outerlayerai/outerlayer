import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS export.
import { countWeakAssertions } from '../check-weak-test-assertions.mjs';

/**
 * The detector must flag the weak-only forms the doctrine bans WITHOUT
 * false-flagging the strong/negative forms — a false fail on a legitimate
 * `.not.toHaveBeenCalled()` would erode trust in the gate.
 */
describe('countWeakAssertions', () => {
  it.each([
    ['expect(x).toBeDefined();', 1],
    ['expect(x).toBeTruthy();', 1],
    ['expect(x).toBeFalsy();', 1],
    ['expect(fn).toHaveBeenCalled();', 1],
    ['expect(() => run()).not.toThrow();', 1],
  ])('flags %s', (src, expected) => {
    expect(countWeakAssertions(src)).toBe(expected);
  });

  it('counts multiple weak matchers across lines', () => {
    const src = `
      expect(a).toBeDefined();
      expect(b).toBeTruthy();
      expect(spy).toHaveBeenCalled();
    `;
    expect(countWeakAssertions(src)).toBe(3);
  });

  it('does NOT flag negative assertions (they express a real expectation)', () => {
    expect(countWeakAssertions('expect(x).not.toBeDefined();')).toBe(0);
    expect(countWeakAssertions('expect(spy).not.toHaveBeenCalled();')).toBe(0);
    expect(countWeakAssertions('expect(x).not.toBeTruthy();')).toBe(0);
  });

  it('does NOT flag the strong, argumented forms', () => {
    expect(countWeakAssertions('expect(fn).toHaveBeenCalledWith(1, 2);')).toBe(0);
    expect(countWeakAssertions('expect(fn).toHaveBeenCalledTimes(3);')).toBe(0);
    expect(countWeakAssertions("expect(() => f()).toThrow('boom');")).toBe(0);
    expect(countWeakAssertions('expect(x).toEqual({ a: 1 });')).toBe(0);
  });

  it('ignores matches inside comment lines', () => {
    expect(countWeakAssertions('// never use .toBeDefined() as the only assertion')).toBe(0);
    expect(countWeakAssertions(' * prefer toEqual over .toBeTruthy()')).toBe(0);
  });

  it('flags two weak matchers on the same line', () => {
    expect(countWeakAssertions('expect(a).toBeDefined(); expect(b).toBeTruthy();')).toBe(2);
  });
});
