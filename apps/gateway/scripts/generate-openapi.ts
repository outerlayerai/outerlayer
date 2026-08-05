#!/usr/bin/env tsx
/**
 * OpenAPI spec generator.
 *
 * Boots the gateway's `OpenAPIHono` app in Node (without listening) and asks
 * chanfana for the generated OpenAPI document, then writes the result to
 * `docs/openapi.yaml`.
 *
 * Why this exists: a hand-maintained `docs/openapi.yaml` drifts from the
 * Zod-backed chanfana routes (the ground truth served at `/v1/openapi.json`).
 * This script is the single path from the gateway's `BaseRoute` subclasses to
 * the committed spec — run it on every gateway-route change and let the CI
 * drift workflow fail the PR otherwise.
 *
 * Usage:
 *   yarn gen:openapi                            # root of the monorepo
 *   yarn workspace gateway gen:openapi          # from anywhere
 *   tsx apps/gateway/scripts/generate-openapi.ts
 *   tsx apps/gateway/scripts/generate-openapi.ts --out /tmp/foo.yaml
 *
 * Determinism:
 *   - YAML is emitted with `sortMapEntries: true` so key ordering is stable.
 *   - The output begins with an autogen banner so reviewers know not to
 *     hand-edit the file.
 *
 * Runtime notes:
 *   - The `openApiApp` lives in `@repo/gateway-core` (a `type: module` package).
 *     Rather than import its `.ts` source through tsx — which trips Node's ESM
 *     linker on CJS workspace deps (see the esbuild block below) — we bundle it
 *     with esbuild, which resolves the whole graph and stubs `octokit` /
 *     `cloudflare:workers`.
 *   - No analytics / Supabase / Unkey calls happen during schema generation —
 *     chanfana walks the registered routes' Zod schemas without invoking any
 *     handler code — so a no-op GatewayContext satisfies the `/v1/*` middleware.
 */

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { build } from 'esbuild';

// ---------------------------------------------------------------------------
// Resolve this file and its repo-relative siblings.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the gateway app's src directory (CF shell — still holds the
 * `cloudflare:workers` mock the CJS/ESM shims below point at). */
const GATEWAY_SRC = resolve(__dirname, '..', 'src');

/** Absolute path to the extracted runtime-neutral core's src directory. The
 * `openApiApp` lives here since the packages/gateway-core split. */
const GATEWAY_CORE_SRC = resolve(__dirname, '..', '..', '..', 'packages', 'gateway-core', 'src');

// ---------------------------------------------------------------------------
// Load the openApiApp by BUNDLING it with esbuild first.
//
// The app lives in `@repo/gateway-core`, a `type: module` package. Importing
// its `.ts` source directly through tsx makes Node's native ESM linker verify
// named imports against CJS workspace deps (e.g. `@repo/observability-service`,
// whose `createVerifiedAppId` is re-exported through multi-hop `export *`
// chains). cjs-module-lexer can't follow those chains, so the import throws
// `does not provide an export named …`. esbuild resolves the whole graph itself
// and emits a self-contained ESM module with the named bindings materialized,
// sidestepping the interop gap — and, as a bonus, handles the exports-only
// `octokit` package without forcing this script into ESM mode.
//
// Stubbed specifiers (resolved by the plugin below):
//   - `octokit` — the git service pulls it in transitively. No handler runs
//     during schema generation, so a no-op object suffices and we avoid
//     bundling the full client.
//   - `cloudflare:workers` — a virtual Workers-runtime module. gateway-core is
//     CF-free (enforced by check-gateway-core-imports.mjs) so the openapi graph
//     shouldn't reach it. The stub stays so that an accidental import fails
//     as a stub call rather than an unresolved-module build error.
// ---------------------------------------------------------------------------

const CLOUDFLARE_WORKERS_STUB_PATH = resolve(GATEWAY_SRC, '__mocks__', 'cloudflare-workers.ts');
const OCTOKIT_STUB_PATH = resolve(__dirname, 'octokit-stub.mjs');

// The `/v1/*` gtx middleware throws unless an entrypoint injects a
// BuildGatewayContext; openapi/index.ts does not import the CF one itself.
// Schema generation runs no handler, so the runtime-neutral no-op context from
// gateway-core's own test-helpers is exactly right — it satisfies the middleware
// without dragging in Stripe / @logtail / Durable Objects. A tiny stdin entry
// wires it up before re-exporting the app.
const OPENAPI_INDEX = resolve(GATEWAY_CORE_SRC, 'openapi', 'index.ts');
const FAKE_GTX = resolve(GATEWAY_CORE_SRC, 'test-helpers', 'fake-gateway-context.ts');
const bundled = await build({
  stdin: {
    contents: [
      `import { openApiApp, setGatewayContextFactory } from ${JSON.stringify(OPENAPI_INDEX)};`,
      `import { fakeBuildGatewayContext } from ${JSON.stringify(FAKE_GTX)};`,
      `setGatewayContextFactory(fakeBuildGatewayContext);`,
      `export { openApiApp };`,
    ].join('\n'),
    resolveDir: GATEWAY_CORE_SRC,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  // CJS, not ESM: the graph pulls CJS deps (e.g. @supabase/node-fetch) that
  // `require('stream')` at load. esbuild's ESM output rejects those dynamic
  // node-builtin requires; CJS output keeps `require` native. Node still gives
  // us the `openApiApp` named binding on `await import()` — esbuild annotates
  // the CJS output so cjs-module-lexer sees it.
  format: 'cjs',
  target: 'node22',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'gateway-openapi-stubs',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^octokit$/ }, () => ({ path: OCTOKIT_STUB_PATH }));
        pluginBuild.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: CLOUDFLARE_WORKERS_STUB_PATH,
        }));
      },
    },
  ],
});

// esbuild can't hand back an importable in-memory module, so land the bundle in
// a throwaway temp file, import it, then delete it.
const bundlePath = resolve(tmpdir(), `gateway-openapi-app.${process.pid}.cjs`);
writeFileSync(bundlePath, bundled.outputFiles[0].text, 'utf8');
let openApiApp: (typeof import('@repo/gateway-core/openapi'))['openApiApp'];
try {
  ({ openApiApp } = (await import(
    pathToFileURL(bundlePath).href
  )) as typeof import('@repo/gateway-core/openapi'));
} finally {
  rmSync(bundlePath, { force: true });
}

// ---------------------------------------------------------------------------
// Fetch the spec.
//
// The post-processing middleware in src/openapi/index.ts runs only when the
// /v1/openapi.json route is fetched, so we go through `.fetch()` rather than
// reading `openApiApp.schema` directly — that way the BearerAuth/AppId
// security schemes and global security entries end up in the YAML too.
// ---------------------------------------------------------------------------

const res = await openApiApp.fetch(
  new Request('http://localhost/v1/openapi.json'),
  // Minimal env binding — no handler code runs, so these placeholders are fine.
  {
    CLICKHOUSE_HOST: 'http://localhost:8123',
    CLICKHOUSE_PASSWORD: '',
    NODE_ENV: 'production',
  } as unknown as Record<string, string>,
);

if (res.status !== 200) {
  const body = await res.text();
  throw new Error(
    `Expected 200 from /v1/openapi.json, got ${res.status}. Body:\n${body}`,
  );
}

const spec = (await res.json()) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Serialize deterministically.
//
// No doc-only enrichment happens here — all metadata (info prose, servers,
// tags, security schemes) lives in the gateway's Chanfana bootstrap so the
// generator script has nothing to patch. If a consumer wants different
// framing, update `apps/gateway/src/openapi/index.ts`, not this file.
// ---------------------------------------------------------------------------

const banner =
  '# AUTO-GENERATED — DO NOT EDIT BY HAND.\n' +
  '# Source of truth: apps/gateway/src/openapi/ (Chanfana + Zod schemas).\n' +
  '# Regenerate via `yarn gen:openapi`. CI enforces no drift.\n';

const yaml = stringifyYaml(spec, {
  sortMapEntries: true,
  // Double-quote strings to keep YAML output stable across `yaml` versions
  // (single-quote + folded scalars shift under minor upgrades).
  defaultStringType: 'QUOTE_DOUBLE',
  defaultKeyType: 'PLAIN',
  lineWidth: 0, // Disable line wrapping — wrap points are a source of churn.
});

// ---------------------------------------------------------------------------
// Resolve output path.
//
// Defaults to `docs/openapi.yaml` (the committed spec); overridable via
// `--out <path>` for ad-hoc diffing against a scratch file.
// ---------------------------------------------------------------------------

const OUTPUT_PATH = parseOutFlag(process.argv.slice(2))
  ?? resolve(__dirname, '..', '..', '..', 'docs', 'openapi.yaml');

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, banner + yaml, 'utf8');

 
console.log(
  `Wrote ${OUTPUT_PATH} (${yaml.length} bytes, ${
    Object.keys((spec.paths ?? {}) as Record<string, unknown>).length
  } paths)`,
);

/**
 * Parse `--out <path>` out of argv. Returns an absolute path or null.
 */
function parseOutFlag(argv: string[]): string | null {
  const idx = argv.indexOf('--out');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('--out requires a path argument');
  }
  return resolve(value);
}
