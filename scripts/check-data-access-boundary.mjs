import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';

/**
 * Gate: keep the RLS-bypassing Supabase admin client inside the service layer.
 *
 * `createSupabaseAdminClient()` (legacy) and `getAdminDataClient()` (new-world,
 * `src/lib/system/admin-client.ts`) each construct a `service_role` client
 * that bypasses Row-Level Security. When either is constructed ad hoc in a
 * route handler, page, or section-level server action — instead of behind a
 * `services/` API (or, new-world, `lib/system/**`/an EE feature's
 * `service.ts`) that owns the authorization decision — a missing permission
 * check silently exposes cross-tenant data — a service-role client
 * constructed outside the sanctioned tiers evades the review that would
 * otherwise have caught the missing gate (e.g. SSO writes made through the
 * admin client with no owner/admin check).
 *
 * This is a SHRINK-ONLY ratchet against a frozen baseline (mirrors
 * check-no-supabase-test-mocks.mjs):
 *   - a file already in the baseline is tolerated (existing debt),
 *   - a NEW offender (admin client outside the allowed homes) fails the build,
 *   - a baseline entry that no longer offends (moved into a service, or deleted)
 *     ALSO fails, forcing the baseline DOWN as debt is paid.
 *
 * Allowed homes (never flagged): the service layer (`src/services/**`,
 * `ee/services/**`), the new-world system layer (`src/lib/system/**`, which
 * owns `getAdminDataClient`), and the legacy factory module itself. Regenerate
 * the baseline with `--update-baseline` after intentionally moving usage into
 * one of those homes.
 */

const ROOT = 'apps/tenant-dashboard';
const BASELINE_PATH = path.join(process.cwd(), 'scripts/data-access-boundary.baseline.json');

// Either admin-client factory's invocation. Matches the call, not a bare import.
const ADMIN_CLIENT_CALL = /\b(?:createSupabaseAdminClient|getAdminDataClient)\s*\(/;

/** True if `source` actually CALLS an admin-client factory (ignoring bare imports and comment lines). */
export function hasAdminClientCall(source) {
  return source.split('\n').some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
    return ADMIN_CLIENT_CALL.test(line);
  });
}

/** True if the repo-relative path may legitimately build an admin client (service layers + factories). */
export function isAllowedHome(relPath) {
  return (
    // the service layer owns authorization + the admin client
    /\/(?:src|ee)\/services\//.test(`/${relPath}`) ||
    // the new-world system layer — the sole home of getAdminDataClient
    relPath.startsWith(`${ROOT}/src/lib/system/`) ||
    // the factory module that defines createSupabaseAdminClient itself
    relPath === `${ROOT}/src/supabaseAdminClient.ts`
  );
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return [];
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? [];
}

/** Repo-relative offender paths: non-test source files that build the admin client outside a service. */
export function scan() {
  const files = globSync('{src,ee}/**/*.{ts,tsx}', {
    cwd: ROOT,
    absolute: true,
    ignore: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**'],
  });

  const offenders = [];
  for (const file of files) {
    const relPath = path.relative(process.cwd(), file).split(path.sep).join('/');
    if (isAllowedHome(relPath)) continue;
    if (hasAdminClientCall(readFileSync(file, 'utf8'))) offenders.push(relPath);
  }
  return offenders.sort();
}

function main() {
  if (process.argv.includes('--update-baseline')) {
    const files = scan();
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ files }, null, 2)}\n`);
    console.log(`Wrote ${files.length} file(s) to ${path.relative(process.cwd(), BASELINE_PATH)}.`);
    return 0;
  }

  const offenders = scan();
  const offenderSet = new Set(offenders);
  const baseline = new Set(loadBaseline());

  const newOffenders = offenders.filter((f) => !baseline.has(f));
  const staleBaseline = [...baseline].filter((f) => !offenderSet.has(f)).sort();

  let failed = false;

  if (newOffenders.length > 0) {
    failed = true;
    console.error(
      `\n❌ An admin-client factory (createSupabaseAdminClient/getAdminDataClient) used outside the ` +
        `allowed homes in ${newOffenders.length} new file(s):\n` +
        newOffenders.map((f) => `   - ${f}`).join('\n') +
        `\n\nThe RLS-bypassing admin client must be constructed inside src/services/**, ee/services/**,\n` +
        `or src/lib/system/**, behind an API that owns the authorization check — constructing it\n` +
        `outside those tiers evades the review that would otherwise catch a missing permission gate.\n` +
        `Move the query into a service, or — if this is an intentional, reviewed exception — re-baseline\n` +
        `with:\n` +
        `   node scripts/check-data-access-boundary.mjs --update-baseline\n`,
    );
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(
      `\n❌ ${staleBaseline.length} baseline entr(y/ies) no longer use the admin client outside services.\n` +
        `The ratchet only shrinks — regenerate the baseline to lock in the progress:\n` +
        staleBaseline.map((f) => `   - ${f}`).join('\n') +
        `\n\n   node scripts/check-data-access-boundary.mjs --update-baseline\n`,
    );
  }

  if (failed) return 1;
  console.log(
    `✓ data-access boundary: ${offenders.length} baselined admin-client usage(s) outside services, no new ones.`,
  );
  return 0;
}

// Run as a CLI only when invoked directly (importing for tests does not execute).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
