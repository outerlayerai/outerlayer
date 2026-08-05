#!/usr/bin/env tsx
/**
 * Dashboard OpenAPI spec generator.
 *
 * Mirrors `apps/gateway/scripts/generate-openapi.ts`. Walks
 * `src/lib/api/route-manifest.ts` (which side-effect imports every migrated
 * route), collects the registered Zod schemas from
 * `dashboardApiRegistry`, and writes `docs/dashboard-openapi.yaml`.
 *
 * Usage:
 *   yarn workspace tenant-dashboard gen:openapi
 *   tsx apps/tenant-dashboard/scripts/generate-openapi.ts
 *   tsx apps/tenant-dashboard/scripts/generate-openapi.ts --out /tmp/foo.yaml
 *
 * Next runtime shims:
 *   - `next/headers`   — returns a no-op cookie/header store. Safe because
 *     `withApi` only *closes over* `createSupabaseServerClient` in handler
 *     code; spec generation never calls those handlers.
 *   - `server-only`    — no-op. The real module errors in client bundles,
 *     not Node, but some versions check `process.env.NEXT_RUNTIME`; stubbing
 *     avoids environment-sensitive behaviour.
 *
 * Determinism:
 *   - `sortMapEntries: true` for stable key ordering
 *   - Double-quoted strings to avoid YAML-version churn
 */

// Must run before any app-code import so t3-oss/env doesn't throw on missing
// runtime variables during schema generation.
process.env.SKIP_ENV_VALIDATION = 'true';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Module from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DASHBOARD_SRC = resolve(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// Install Next-runtime shims before importing any app code.
// ---------------------------------------------------------------------------

type LoadFn = (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;
const ModuleInternals = Module as unknown as { _load: LoadFn };
const originalLoad = ModuleInternals._load.bind(Module);

ModuleInternals._load = function patchedLoad(
  request: string,
  parent: NodeJS.Module | null,
  isMain: boolean,
): unknown {
  if (request === 'server-only') {
    return {};
  }
  if (request === 'next/headers') {
    return {
      cookies: async () => ({
        get: () => undefined,
        set: () => {},
        delete: () => {},
      }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false, enable: () => {}, disable: () => {} }),
    };
  }
  return originalLoad(request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Import the manifest + registry AFTER shims are installed.
// ---------------------------------------------------------------------------

await import(resolve(DASHBOARD_SRC, 'lib', 'api', 'route-manifest.ts'));
const { generateDashboardSpec } = (await import(
  resolve(DASHBOARD_SRC, 'lib', 'api', 'registry.ts')
)) as typeof import('../src/lib/api/registry');
const { applyDashboardSpecPostprocess } = (await import(
  resolve(DASHBOARD_SRC, 'lib', 'api', 'spec-postprocess.ts')
)) as typeof import('../src/lib/api/spec-postprocess');

const rawSpec = generateDashboardSpec() as unknown as Record<string, unknown>;
const spec = applyDashboardSpecPostprocess(rawSpec);

// ---------------------------------------------------------------------------
// Serialize deterministically.
// ---------------------------------------------------------------------------

const banner =
  '# AUTO-GENERATED — DO NOT EDIT BY HAND.\n' +
  '# Source of truth: apps/tenant-dashboard/src/app/api/**/route.ts (withApi + Zod).\n' +
  '# Regenerate via `yarn workspace tenant-dashboard gen:openapi`. CI enforces no drift.\n';

// Cast to any — yaml@2 ships `sortMapEntries` but its TS types lag behind.
// `aliasDuplicateObjects: false` prevents YAML &anchor/*alias emission when
// the same Zod-generated schema surfaces in multiple operations (e.g.
// `SavedFilterSchema` in list + create + detail). OpenAPI is expected to
// deduplicate via `$ref`, not YAML anchors — alias emission fails
// serialization when the second occurrence sits in a different branch of
// the tree.
const yaml = YAML.stringify(spec, {
  sortMapEntries: true,
  lineWidth: 0,
  // Force each duplicated object to be inlined rather than emitted as an
  // &anchor / *alias. OpenAPI consumers expect deduplication via `$ref`,
  // not YAML anchors. yaml@1 had no way to disable this cleanly; yaml@2
  // does via `aliasDuplicateObjects: false`.
  aliasDuplicateObjects: false,
} as unknown as Parameters<typeof YAML.stringify>[1]);

const OUTPUT_PATH =
  parseOutFlag(process.argv.slice(2)) ??
  resolve(__dirname, '..', '..', '..', 'docs', 'dashboard-openapi.yaml');

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, banner + yaml, 'utf8');

// eslint-disable-next-line no-console
console.log(
  `Wrote ${OUTPUT_PATH} (${yaml.length} bytes, ${
    Object.keys((spec.paths ?? {}) as Record<string, unknown>).length
  } paths)`,
);

function parseOutFlag(argv: string[]): string | null {
  const idx = argv.indexOf('--out');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value) throw new Error('--out requires a path argument');
  return resolve(value);
}
