import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import { crossAppRefs, declaredDeps, scan } from '../ci/check-cross-app-bundling.mjs';

/**
 * The detector must recognize BOTH ways an esbuild config reaches into a sibling
 * app through a `..` relative path — a path literal (`"../builder/src/…"`) and
 * `path.resolve` args (`"..", "builder"`) — and must not match a sibling that
 * merely shares a substring or is referenced without a `..` hop. A miss here
 * lets an undeclared cross-app bundle slip the gate.
 */
describe('crossAppRefs', () => {
  const siblings = ['builder', 'gateway', 'tenant-dashboard'];

  it.each([
    ['path literal', 'entryPoints: { builder: "../builder/src/index.ts" }', ['builder']],
    ['resolve args', 'resolve(here, "..", "builder", "src", "scripts")', ['builder']],
    ["single-quoted resolve args", "resolve(here, '..', 'builder', 'src')", ['builder']],
    ['both forms in one file', '"../builder/src/index.ts"; resolve(h, "..", "builder", "s")', ['builder']],
    ['two distinct siblings', '"../builder/src"; "../gateway/src"', ['builder', 'gateway']],
    ['hyphenated dir name', 'import "../tenant-dashboard/src/x"', ['tenant-dashboard']],
    ['no cross-app ref', 'entryPoints: { index: "src/index.ts" }', []],
    ['own-dir relative (no `..`)', 'import "./builder/local"', []],
    ['substring is not a match', '"../gateway-node/src"', []], // 'gateway' must not match 'gateway-node'
    ['bare mention without path', 'const builder = makeBuilder();', []],
  ])('%s', (_label, source, expected) => {
    expect([...crossAppRefs(source, siblings)].sort()).toEqual(expected.sort());
  });
});

/**
 * The declared-dependency set the guard checks against is the union of runtime
 * and dev dependencies (a build-time bundle is legitimately a devDependency).
 */
describe('declaredDeps', () => {
  it('unions dependencies and devDependencies', () => {
    const deps = declaredDeps({
      dependencies: { hono: '^4', '@repo/gateway-core': 'workspace:*' },
      devDependencies: { builder: 'workspace:*', vitest: '^4' },
    });
    expect(deps).toEqual(new Set(['hono', '@repo/gateway-core', 'builder', 'vitest']));
  });

  it.each([
    ['only dependencies', { dependencies: { a: '1' } }, ['a']],
    ['only devDependencies', { devDependencies: { b: '2' } }, ['b']],
    ['neither', {}, []],
  ])('handles a package with %s', (_label, pkg, expected) => {
    expect(declaredDeps(pkg)).toEqual(new Set(expected));
  });
});

/**
 * Integration against the real repo: with `builder` declared in gateway-node's
 * package.json (the fix), the guard must find zero violations. Revert that dep
 * and this fails — the same signal CI would give.
 */
describe('scan (real workspace tree)', () => {
  it('reports no cross-app bundling violations on the current tree', () => {
    expect(scan()).toEqual([]);
  });
});
