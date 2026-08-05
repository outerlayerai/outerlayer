import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

// Anchor to the repo root (this file is at scripts/ci/) so the guard runs the
// same whether CI invokes it from the repo root or the gateway `lint` script
// invokes it from apps/gateway.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Gate: the extracted gateway core imports no runtime-coupled vendor.
 *
 * The node-gateway runtime refactor extracted the runtime-agnostic core — the
 * Hono app, routes, services, lib, and the `runtime/` DI interfaces — into
 * `packages/gateway-core`, leaving a thin CF-side shell in `apps/gateway` (the
 * Worker entry, Durable Objects, the Cloudflare adapters, and the
 * `@logtail/edge` / `@sentry/cloudflare` / Stripe facade impls). A Node
 * entrypoint can run the core with no Cloudflare account.
 *
 * This guard enforces that boundary by import, not by discipline: every file in
 * `packages/gateway-core/src` must be free of the forbidden vendor specifiers
 * below. A new import of one of them fails CI — either the coupling belongs in
 * apps/gateway (behind a `gtx` seam), or the file belongs there, not in core.
 *
 * NOTE: `@unkey/*` is intentionally NOT forbidden — it is a Node-safe HTTP SDK
 * owned by the separate keystore-seam chain; it stays in core until that chain
 * replaces it (see the plan's transitive-import audit).
 */

const SRC_ROOT = 'packages/gateway-core/src';

/** Specifiers a core file may not import. Matched exactly or as a subpath
 * (`@sentry/cloudflare`, `@sentry/cloudflare/foo`), and — for `cloudflare:` —
 * as any `cloudflare:*` builtin. */
const FORBIDDEN = [
  'cloudflare:workers',
  '@cloudflare/workers-types',
  '@logtail/edge',
  '@sentry/cloudflare',
  'bullmq',
  'ws',
  '@hono/node-server',
  'stripe',
];

/**
 * After the Step-4 extraction the whole of `packages/gateway-core/src` is core —
 * the CF-side impls all live in `apps/gateway` now, so there is nothing to
 * exclude. Kept as an (empty) explicit list so the intent is legible.
 */
const CF_SIDE = [];

/** Test / mock files are not shipped in either bundle; skip them. */
function isTestFile(rel) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    rel.startsWith('tests/') ||
    rel.includes('/tests/') ||
    rel.startsWith('test-helpers/') ||
    rel.includes('/test-helpers/') ||
    rel.startsWith('__mocks__/') ||
    rel.includes('/__mocks__/')
  );
}

function isCfSide(rel) {
  return CF_SIDE.some((entry) =>
    entry.endsWith('/') ? rel.startsWith(entry) : rel === entry,
  );
}

function isForbidden(spec) {
  if (spec.startsWith('cloudflare:')) return true;
  return FORBIDDEN.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
}

/**
 * Layering rule (architecture review #5): the runtime layer (`runtime/`) and the
 * thin transport routes (`routes/`) must NOT import from the OpenAPI route
 * handlers (`openapi/routes/`). Shared helpers belong in neutral modules
 * (`src/errors.ts`, `src/responses.ts`, `src/lib/**`). This caught the inversion
 * where the runtime pulled `structuredError` out of `openapi/routes/_shared`.
 */
function isLayeringViolation(rel, spec) {
  const inRuntimeOrTransport =
    (rel.startsWith('runtime/') || rel.startsWith('routes/')) && !rel.startsWith('openapi/');
  return inRuntimeOrTransport && /(^|\/)openapi\/routes\//.test(spec);
}

/** Every module specifier a file imports: `from '…'`, side-effect `import '…'`,
 * dynamic `import('…')`, and `require('…')`. Relative specifiers are skipped by
 * the caller. Doc comments in this repo reference vendors with backticks, never
 * a real `from '…'`/`import '…'`, so a plain-regex scan does not false-positive. */
function* specifiers(source) {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const [, spec] of source.matchAll(re)) yield spec;
  }
}

const files = globSync('**/*.{ts,tsx,mts,cts}', {
  cwd: path.join(REPO_ROOT, SRC_ROOT),
});

const violations = [];
const layeringViolations = [];
let coreFileCount = 0;

for (const rel of files) {
  if (isTestFile(rel) || isCfSide(rel)) continue;
  coreFileCount += 1;

  const source = readFileSync(path.join(REPO_ROOT, SRC_ROOT, rel), 'utf8');
  const hits = new Set();
  const layeringHits = new Set();
  for (const spec of specifiers(source)) {
    if (isForbidden(spec)) hits.add(spec);
    if (isLayeringViolation(rel, spec)) layeringHits.add(spec);
  }
  if (hits.size > 0) {
    violations.push({ file: `${SRC_ROOT}/${rel}`, specs: [...hits].sort() });
  }
  if (layeringHits.size > 0) {
    layeringViolations.push({ file: `${SRC_ROOT}/${rel}`, specs: [...layeringHits].sort() });
  }
}

if (violations.length > 0) {
  console.error(
    [
      'gateway-core import guard: forbidden vendor imports found in core files.',
      '',
      'Each core file must run on a Node entrypoint with no Cloudflare account.',
      'Either move the file to the CF side (add it to CF_SIDE in this script) or',
      'route the coupling through a `gtx` seam.',
      '',
      ...violations
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((v) => `- ${v.file}\n    ${v.specs.join(', ')}`),
    ].join('\n'),
  );
  process.exit(1);
}

if (layeringViolations.length > 0) {
  console.error(
    [
      'gateway-core import guard: layering violation — runtime/transport imports from openapi/routes.',
      '',
      'The runtime (runtime/) and thin transport routes (routes/) must not import',
      'from the OpenAPI route handlers (openapi/routes/). Move the shared helper to',
      'a neutral module (src/errors.ts, src/responses.ts, src/lib/**) and import it',
      'from there.',
      '',
      ...layeringViolations
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((v) => `- ${v.file}\n    ${v.specs.join(', ')}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `gateway-core import guard: OK — ${coreFileCount} core file(s) free of ` +
    `${FORBIDDEN.length} forbidden vendor(s) and the runtime→openapi/routes layering rule.`,
);
