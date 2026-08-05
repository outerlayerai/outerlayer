import { describe, it, expect } from 'vitest';

import { getArrowOrigins, getArrowPaperOffset } from './arrow-origins';
import type { MenuPopoverArrowValue } from './types';

// ----------------------------------------------------------------------

// The origin table IS the popover's observable placement behaviour: for each
// arrow value, where the Paper anchors to the trigger and where it transforms
// from. Hardcoded (not re-derived from the production logic) so a mutant that
// flips an axis or swaps an origin breeds no survivor across the 12 branches —
// including the 9 that currently have no consumer.
type Origin = { vertical: 'top' | 'center' | 'bottom'; horizontal: 'left' | 'center' | 'right' };

const ORIGIN_CASES: ReadonlyArray<
  [MenuPopoverArrowValue, { anchorOrigin: Origin; transformOrigin: Origin }]
> = [
  ['top-left', { anchorOrigin: { vertical: 'bottom', horizontal: 'left' }, transformOrigin: { vertical: 'top', horizontal: 'left' } }],
  ['top-center', { anchorOrigin: { vertical: 'bottom', horizontal: 'center' }, transformOrigin: { vertical: 'top', horizontal: 'center' } }],
  ['top-right', { anchorOrigin: { vertical: 'bottom', horizontal: 'right' }, transformOrigin: { vertical: 'top', horizontal: 'right' } }],
  ['bottom-left', { anchorOrigin: { vertical: 'top', horizontal: 'left' }, transformOrigin: { vertical: 'bottom', horizontal: 'left' } }],
  ['bottom-center', { anchorOrigin: { vertical: 'top', horizontal: 'center' }, transformOrigin: { vertical: 'bottom', horizontal: 'center' } }],
  ['bottom-right', { anchorOrigin: { vertical: 'top', horizontal: 'right' }, transformOrigin: { vertical: 'bottom', horizontal: 'right' } }],
  ['left-top', { anchorOrigin: { vertical: 'top', horizontal: 'right' }, transformOrigin: { vertical: 'top', horizontal: 'left' } }],
  ['left-center', { anchorOrigin: { vertical: 'center', horizontal: 'right' }, transformOrigin: { vertical: 'center', horizontal: 'left' } }],
  ['left-bottom', { anchorOrigin: { vertical: 'bottom', horizontal: 'right' }, transformOrigin: { vertical: 'bottom', horizontal: 'left' } }],
  ['right-top', { anchorOrigin: { vertical: 'top', horizontal: 'left' }, transformOrigin: { vertical: 'top', horizontal: 'right' } }],
  ['right-center', { anchorOrigin: { vertical: 'center', horizontal: 'left' }, transformOrigin: { vertical: 'center', horizontal: 'right' } }],
  ['right-bottom', { anchorOrigin: { vertical: 'bottom', horizontal: 'left' }, transformOrigin: { vertical: 'bottom', horizontal: 'right' } }],
];

describe('getArrowOrigins', () => {
  it.each(ORIGIN_CASES)('maps %s to the correct anchor/transform origins', (arrow, expected) => {
    expect(getArrowOrigins(arrow)).toEqual(expected);
  });

  it('covers all 12 arrow values', () => {
    expect(ORIGIN_CASES).toHaveLength(12);
    expect(new Set(ORIGIN_CASES.map(([a]) => a)).size).toBe(12);
  });
});

// The paper nudge realigns the edge-inset arrow over the trigger. Hardcoded per
// value so the sign/axis branches (again mostly unconsumed) can't survive.
const OFFSET_CASES: ReadonlyArray<[MenuPopoverArrowValue, { ml?: number; mt?: number }]> = [
  ['top-left', { ml: -0.75 }],
  ['top-center', {}],
  ['top-right', { ml: 0.75 }],
  ['bottom-left', { ml: -0.75 }],
  ['bottom-center', {}],
  ['bottom-right', { ml: 0.75 }],
  ['left-top', { mt: -0.75 }],
  ['left-center', {}],
  ['left-bottom', { mt: 0.75 }],
  ['right-top', { mt: -0.75 }],
  ['right-center', {}],
  ['right-bottom', { mt: 0.75 }],
];

describe('getArrowPaperOffset', () => {
  it.each(OFFSET_CASES)('nudges the paper for %s', (arrow, expected) => {
    expect(getArrowPaperOffset(arrow)).toEqual(expected);
  });
});
