/**
 * Tests for safeCompare — constant-time string comparison (timing-attack safe).
 *
 * Each case targets a specific bug class the earlier 0%-mutation run let survive:
 *  - the length pre-check (`!==` / early `return false`)
 *  - the per-byte XOR accumulator (`^`, `|=`, the loop bound)
 *  - the final `result === 0` verdict
 * A weakening of any of these would let a non-matching token compare equal —
 * an auth bypass — so the assertions pin exact true/false outcomes.
 */

import { describe, it, expect } from 'vitest';
import { safeCompare } from './safe-compare';

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('returns true for two empty strings', () => {
    expect(safeCompare('', '')).toBe(true);
  });

  it('returns false for same-length strings differing in one byte', () => {
    // Kills: removing the XOR accumulator, skipping the loop, or flipping the
    // final `=== 0` — any of which would wrongly report these as equal.
    expect(safeCompare('abc', 'abd')).toBe(false);
  });

  it('returns false when lengths differ (mismatch is shorter)', () => {
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });

  it('returns false when lengths differ (mismatch is longer)', () => {
    // Kills mutating the length check `!==` to `===` (which would skip the
    // guard and fall through to a partial compare).
    expect(safeCompare('abcd', 'abc')).toBe(false);
  });

  it('returns false for bit-disjoint bytes (kills XOR→AND/OR mutations)', () => {
    // 0x01 ^ 0x02 = 3 (differ) but 0x01 & 0x02 = 0 (would falsely match if the
    // accumulator used AND instead of XOR).
    expect(safeCompare('\x01', '\x02')).toBe(false);
  });

  it('compares by encoded bytes, not code points (multibyte equal)', () => {
    expect(safeCompare('café—™', 'café—™')).toBe(true);
  });

  it('returns false for multibyte strings of equal code-point length but different content', () => {
    expect(safeCompare('café', 'cafè')).toBe(false);
  });
});
