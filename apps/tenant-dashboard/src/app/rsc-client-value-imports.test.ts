/**
 * A Server Component that imports a VALUE out of a `"use client"` module does
 * not get the value — the bundler hands back an opaque client reference, so
 * the first property read (`.find`, `.map`, `.length`) throws at request time
 * and the whole route 500s. Nothing upstream catches it: types resolve
 * normally, `next build` succeeds, and dev-mode HMR can paper over it. It
 * surfaces only as a production render error.
 *
 * Rendering an imported CLIENT COMPONENT is the one legitimate case — that is
 * what the reference is for. So the invariant is narrow: a binding imported
 * from a `"use client"` module into a server file may appear only in JSX tag
 * position. Any other use dereferences the proxy.
 *
 * Fix a violation by moving the shared value into a module with no
 * `"use client"` directive and importing it from both sides.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const APP = __dirname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const hasUseClient = (source: string) => /^\s*(['"])use client\1\s*;?/.test(source.trimStart());

/** Comments and string/template bodies are stripped before use-site analysis:
 * a doc comment naming the binding is not a dereference of it. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** Named bindings of an import clause, minus `import type` / `{ type X }`. */
function valueBindings(clause: string): string[] {
  if (/^\s*type\s/.test(clause)) return [];
  const named = clause.match(/\{([\s\S]*)\}/);
  if (!named?.[1]) return [];
  return named[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^type\s/.test(s))
    .map((s) => (s.split(/\s+as\s+/)[1] ?? s).trim())
    .filter(Boolean);
}

/** Occurrences of `name` that are NOT `<name` / `</name` JSX tag positions. */
function nonJsxUses(code: string, name: string): number {
  let count = 0;
  for (const match of code.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
    const before = code.slice(0, match.index).replace(/\s+$/, '');
    if (before.endsWith('<') || before.endsWith('</')) continue;
    count += 1;
  }
  return count;
}

/**
 * Bindings this server file imports from a `"use client"` module and then
 * dereferences. `isClientModule` decides, for an import specifier, whether it
 * resolves to a client module — injected so the detector test can drive the
 * real function without touching the filesystem.
 */
function findViolations(source: string, isClientModule: (specifier: string) => boolean): string[] {
  if (hasUseClient(source)) return [];
  const found: string[] = [];
  for (const stmt of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [statement, clause, specifier] = stmt;
    if (!clause || !specifier || stmt.index === undefined) continue;
    if (!isClientModule(specifier)) continue;
    // Analyse only what FOLLOWS the import, so the specifier in the import
    // clause itself is not mistaken for a use site.
    const body = stripNonCode(source.slice(stmt.index + statement.length));
    for (const name of valueBindings(clause)) {
      if (nonJsxUses(body, name) > 0) found.push(`${name} <- ${specifier}`);
    }
  }
  return found;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

describe('server files under src/app', () => {
  it('never dereferences a value imported from a "use client" module', () => {
    const clientCache = new Map<string, boolean>();
    const violations: string[] = [];

    const files = walk(APP);
    // Guards against the walk silently matching nothing (a moved route root
    // would turn this into a vacuously-passing test).
    expect(files.length).toBeGreaterThan(100);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const isClientModule = (specifier: string) => {
        const target = resolveImport(file, specifier);
        if (!target) return false;
        if (!clientCache.has(target)) clientCache.set(target, hasUseClient(readFileSync(target, 'utf8')));
        return clientCache.get(target)!;
      };
      for (const v of findViolations(source, isClientModule)) {
        violations.push(`${path.relative(SRC, file)}: ${v}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('flags a dereferenced value while exempting a rendered client component', () => {
    const serverPage = `
      import { TIME_RANGES } from "@/features/agent-sessions/components/session-filter-bar";
      import { AgentSessions, type ActiveFilters } from "./agent-sessions";
      import { listSavedFilters } from "@/lib/saved-filters";
      /** TIME_RANGES stays safe to name in a comment. */
      export default function Page() {
        const hours = TIME_RANGES.find((r) => r.key === "24h")?.hours ?? 0;
        return <AgentSessions hours={hours} />;
      }
    `;
    const clientModules = new Set([
      '@/features/agent-sessions/components/session-filter-bar',
      './agent-sessions',
    ]);

    expect(findViolations(serverPage, (s) => clientModules.has(s))).toEqual([
      'TIME_RANGES <- @/features/agent-sessions/components/session-filter-bar',
    ]);
  });

  it('exempts a client module that only declares the boundary for its own subtree', () => {
    const clientPage = `
      "use client";
      import { TIME_RANGES } from "./session-filter-bar";
      export const first = TIME_RANGES[0];
    `;
    expect(findViolations(clientPage, () => true)).toEqual([]);
  });
});
