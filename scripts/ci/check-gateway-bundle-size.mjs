#!/usr/bin/env node
/**
 * Gate: the Cloudflare Worker bundle for `apps/gateway` stays under
 * Cloudflare's 3 MB compressed limit, with headroom.
 *
 * Nothing today catches a bundle that grows past the platform's upload
 * ceiling before `wrangler deploy` in CD — this is the first line of
 * defense, run in CI on every gateway-touching PR.
 *
 * `wrangler deploy --dry-run` runs the real esbuild-based bundler wrangler
 * uses for an actual deploy (same entry point, same externals, same
 * minification) without publishing anything, and prints the gzip-compressed
 * upload size it would send to Cloudflare — the exact number the platform
 * limit applies to. Parsing that line is more faithful than re-implementing
 * the bundler's config by hand and letting it drift from wrangler's own.
 *
 * PREREQUISITE: workspace packages must be built first (the worker bundles
 * their `dist/`), same as `yarn gen:openapi` — `turbo build --filter='{./packages/*}'`.
 *
 * Usage: node scripts/ci/check-gateway-bundle-size.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATEWAY_DIR = path.join(REPO_ROOT, 'apps/gateway');

/** Headroom under Cloudflare's 3 MB compressed Worker upload limit. */
const MAX_COMPRESSED_BYTES = 2.5 * 1024 * 1024;

const outdir = mkdtempSync(path.join(tmpdir(), 'gateway-bundle-check-'));

try {
  const result = spawnSync(
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--env', ''],
    { cwd: GATEWAY_DIR, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    console.error('gateway bundle-size check: `wrangler deploy --dry-run` failed.\n');
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }

  const output = result.stdout;
  const match = /Total Upload:\s*[\d.]+\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/.exec(output);
  if (!match) {
    console.error('gateway bundle-size check: could not parse a "Total Upload: … / gzip: … KiB" line from wrangler output.\n');
    console.error(output);
    process.exit(1);
  }

  const gzipBytes = Number.parseFloat(match[1]) * 1024;
  const gzipMiB = (gzipBytes / (1024 * 1024)).toFixed(2);
  const maxMiB = (MAX_COMPRESSED_BYTES / (1024 * 1024)).toFixed(2);

  if (gzipBytes > MAX_COMPRESSED_BYTES) {
    console.error(
      `gateway bundle-size check: FAILED — compressed Worker bundle is ${gzipMiB} MiB, over the ${maxMiB} MiB ceiling ` +
        `(Cloudflare's platform limit is 3 MiB compressed; this ceiling keeps headroom). Trim the import graph or move ` +
        `the added weight behind a lazy \`import()\`.`,
    );
    process.exit(1);
  }

  console.log(`gateway bundle-size check: OK — ${gzipMiB} MiB compressed (ceiling ${maxMiB} MiB).`);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
