#!/usr/bin/env node
/**
 * Shrink-only allowlist for legacy (non-URL-scoped) tenant API routes.
 *
 * WHY THIS EXISTS.
 *   The canonical home for a tenant-scoped dashboard API route is a URL-scoped
 *   path — `/api/orgs/<org>/…` — where the middleware derives the tenant from the
 *   org segment exactly as it does for pages. Every tenant-scoped route today
 *   still derives its tenant from the JWT claim under a legacy `/api/**` path.
 *   Moving them is an incremental, per-domain effort, so this gate freezes the
 *   current set and forbids GROWTH: a NEW tenant-scoped route must be born under
 *   `/api/orgs/<org>/…`, never added to the legacy surface.
 *
 *   It enumerates every route file under `apps/tenant-dashboard/src/app/api/**`,
 *   subtracts the born-canonical `api/orgs/**` tree and the permanent stay-put
 *   buckets (tenant-agnostic probes, platform-admin, signature webhooks, and the
 *   externally-called cli/cron/internal surfaces — the same prefixes the
 *   middleware matcher already excludes), and fails if any REMAINING legacy
 *   tenant-scoped path is not in the committed allowlist. As each domain slice
 *   moves its routes to the canonical shape, it shrinks the allowlist via
 *   `--update`; the allowlist can only ever remove entries, never add.
 *
 * USAGE
 *   node scripts/ci/check-api-tenancy-allowlist.mjs            # check (CI + pre-push)
 *   node scripts/ci/check-api-tenancy-allowlist.mjs --update   # shrink to reality (removes moved/deleted entries)
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Root override lets the regression self-test point the check at a synthetic
// fixture tree without a real checkout (mirrors check-publish-safety.mjs).
const cwd = process.env.API_TENANCY_CWD ?? process.cwd();
const allowlistPath = path.join(cwd, 'scripts/ci/api-tenancy-allowlist.json');
const apiRoot = path.join(cwd, 'apps/tenant-dashboard/src/app/api');
const update = process.argv.includes('--update');

const ROUTE_FILE = /^route\.(?:[jt]sx?|[mc][jt]s)$/;

/**
 * Permanent stay-put routes: never tenant-scoped by URL. Exact index paths and
 * the prefixes the middleware matcher already excludes, plus platform-admin
 * (spans all tenants) and license (server-env only). Everything else under
 * `api/` that is not born-canonical is a legacy tenant-scoped route.
 *
 * A route earns a stay-put bucket only if it is tenant-agnostic (public probe,
 * platform-admin cross-tenant) or self-authenticated (signature/secret webhooks,
 * cron/cli/internal) — never session-tenant-scoped. The same prefixes the
 * middleware treats as strip-only: adding a session-tenant route here would let
 * it read a claim tenant off-URL, which is exactly what this gate forbids.
 */
const STAY_PUT_EXACT = new Set(['health', 'analytics', 'analytics/health']);
const STAY_PUT_PREFIXES = [
  'orgs/', // born-canonical — allowed by construction, not "legacy"
  'webhooks/',
  'cron/',
  'cli/',
  'internal/',
  'platform-admin/',
  'license/',
  'analytics/health/',
];

/** Every route file under `dir`, as absolute paths. */
function enumerateRouteFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...enumerateRouteFiles(full));
    } else if (ROUTE_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The URL path a route file serves, relative to `api/` — its directory chain
 * minus the `route.*` file. Route groups (`(group)`) and parallel slots (`@slot`)
 * are structural, not part of the URL, so they drop out.
 */
function toRoutePath(file) {
  const rel = path.relative(apiRoot, path.dirname(file));
  return rel
    .split(path.sep)
    .filter((seg) => seg && !(seg.startsWith('(') && seg.endsWith(')')) && !seg.startsWith('@'))
    .join('/');
}

/** True when a route path is born-canonical or in a permanent stay-put bucket. */
function isStayPut(routePath) {
  if (STAY_PUT_EXACT.has(routePath)) return true;
  return STAY_PUT_PREFIXES.some((prefix) => routePath.startsWith(prefix));
}

/** The current legacy (non-canonical, tenant-scoped) route paths, sorted. */
function computeLegacyRoutes() {
  const legacy = new Set();
  for (const file of enumerateRouteFiles(apiRoot)) {
    const routePath = toRoutePath(file);
    if (routePath && !isStayPut(routePath)) legacy.add(routePath);
  }
  return [...legacy].sort();
}

function readAllowlist() {
  if (!existsSync(allowlistPath)) return null;
  const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  return Array.isArray(parsed.routes) ? parsed.routes : [];
}

function writeAllowlist(routes) {
  writeFileSync(allowlistPath, `${JSON.stringify({ routes: [...routes].sort() }, null, 2)}\n`);
}

const legacy = computeLegacyRoutes();

if (update) {
  const committed = readAllowlist();
  // Bootstrap: seed the whole current legacy set when no allowlist exists.
  // Thereafter shrink-only — keep only entries that still exist as legacy
  // routes (drops ones a slice moved to canonical or deleted), never add a
  // newly-introduced legacy route: a new tenant-scoped route must be born
  // canonical, not admitted here.
  const next = committed === null ? legacy : committed.filter((route) => legacy.includes(route));
  writeAllowlist(next);
  console.log(
    committed === null
      ? `Seeded ${allowlistPath} — ${next.length} legacy tenant-scoped route(s).`
      : `Updated ${allowlistPath} — ${next.length} entr(y|ies), ${committed.length - next.length} removed.`,
  );
  process.exit(0);
}

const committed = readAllowlist();
if (committed === null) {
  console.error(
    `API-tenancy allowlist missing at ${allowlistPath}.\n` +
      'Seed it with: node scripts/ci/check-api-tenancy-allowlist.mjs --update',
  );
  process.exit(1);
}

const allowed = new Set(committed);
const legacySet = new Set(legacy);
// A legacy route with no allowlist entry = a new tenant-scoped route on the
// legacy surface. It must be born under /api/orgs/<org>/… instead.
const missing = legacy.filter((route) => !allowed.has(route));
// An allowlist entry that no longer maps to a legacy route = a moved/deleted
// route whose entry must be dropped so the allowlist can't rot.
const stale = committed.filter((route) => !legacySet.has(route));

const output = ['## API tenancy allowlist (shrink-only)\n'];
output.push(`- legacy tenant-scoped routes: ${legacy.length}\n`);
output.push(`- allowlisted: ${committed.length}\n`);
const rendered = output.join('');
process.stdout.write(rendered);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered);
}

if (missing.length === 0 && stale.length === 0) {
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    '\nNew legacy tenant-scoped API route(s) not on the allowlist:',
  );
  for (const route of missing) console.error(`- api/${route}`);
  console.error(
    '\nA new tenant-scoped route must be born under /api/orgs/<org>/… so the\n' +
      'middleware derives its tenant from the URL. Move it there, or if it is\n' +
      'genuinely tenant-agnostic add it to a stay-put bucket.',
  );
}

if (stale.length > 0) {
  console.error('\nAllowlist entry has rotted — route moved or deleted:');
  for (const route of stale) console.error(`- api/${route}`);
  console.error(
    '\nDrop the stale entr(y|ies) with:\n' +
      '  node scripts/ci/check-api-tenancy-allowlist.mjs --update',
  );
}

process.exit(1);
