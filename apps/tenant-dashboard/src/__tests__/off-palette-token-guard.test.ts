import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

// Two off-system styling classes must not creep back into the tree.
//   1. `palette.grey[N]` / `"grey.N"` — cool MUI grey against the warm-neutral
//      clean-room ramp (grey is NOT wired into the palette, so it resolves to
//      MUI's default cool family — a visible mismatch). Route neutral bands
//      through `background.neutral` and hairlines through `divider` instead.
//   2. A static `theme.palette.mode ===` branch — under `cssVariables` it is
//      resolved once at build time and frozen (always light today, silently
//      won't flip when dark ships). Use `theme.applyStyles("dark", …)` /
//      `theme.vars` so the value tracks the active scheme.
// Each guard pins the exact set of sanctioned survivors, so a reintroduced
// offender fails AND removing a sanctioned one surfaces here too.

const SRC = path.resolve(__dirname, '..');
const THIS_FILE = __filename;

const files = globSync('**/*.{ts,tsx}', {
  cwd: SRC,
  absolute: true,
  ignore: ['**/node_modules/**'],
}).filter((file) => file !== THIS_FILE);

function offendersMatching(pattern: RegExp): string[] {
  return files
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();
}

describe('off-palette token guard', () => {
  it('scans the real source tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('confines cool `grey[N]` to the intentional fixed-dark surfaces', () => {
    // The survivor is a deliberate fixed dark that must NOT track the scheme:
    // the snackbar chip.
    const offenders = offendersMatching(/palette\.grey\[|["']grey\.\d/);
    expect(offenders).toEqual([
      'components/snackbar/styles.ts',
    ]);
  });

  it('has no frozen `theme.palette.mode ===` style branches left', () => {
    // Anchored on `palette.mode` so the factory `mode` param in create-theme.ts
    // (a plain `mode === "dark"`) is not caught.
    const offenders = offendersMatching(/palette\.mode ===/);
    expect(offenders).toEqual([]);
  });
});
