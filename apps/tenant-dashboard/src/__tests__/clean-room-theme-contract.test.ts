import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

// The `customShadows` / `themeColorPresets` / `themeContrast` theme APIs do not
// exist. A reference to one anywhere under src/ is a compile break.

const SRC = path.resolve(__dirname, '..');
const THIS_FILE = __filename;

const FORBIDDEN = ['customShadows', 'themeColorPresets', 'themeContrast'];

const files = globSync('**/*.{ts,tsx}', {
  cwd: SRC,
  absolute: true,
  ignore: ['**/node_modules/**'],
}).filter((file) => file !== THIS_FILE);

describe('retired theme contract is gone', () => {
  it('scans the real source tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it.each(FORBIDDEN)('no source file references `%s`', (token) => {
    const offenders = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes(token))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe('theme compat augmentations are pinned', () => {
  // These MUI module augmentations are adopted clean-room design tokens (spec
  // vocabulary the app components read). Pin the exact set so it can't
  // silently grow — a new augmentation must be a conscious edit here, not a
  // quiet addition.
  it('declares exactly lighter/darker/neutral/fontWeightSemiBold/fontFamilyMonospace', () => {
    const src = fs.readFileSync(path.join(SRC, 'theme/create-theme.ts'), 'utf8');
    const start = src.indexOf('declare module');
    const block = src.slice(start, src.indexOf('}\n}', start) + 3);

    const members = [...block.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]);
    const compat = [...new Set(members)].filter((m) => m !== 'enabled').sort();

    // fontFamilyMonospace is the one consciously-added augmentation: the mono
    // stack the theme assigns to code/id surfaces. The rest are
    // adopted design tokens (lighter/darker/neutral fills + the semibold weight).
    expect(compat).toEqual([
      'darker',
      'fontFamilyMonospace',
      'fontWeightSemiBold',
      'lighter',
      'neutral',
    ]);
  });
});
