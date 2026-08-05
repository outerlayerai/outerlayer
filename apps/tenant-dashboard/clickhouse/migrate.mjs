#!/usr/bin/env node
/**
 * Comment-insensitive wrapper around `clickhouse-migrations migrate`.
 *
 * Why: the upstream tool md5s the RAW migration file and refuses to run if an
 * applied file changed — including comment-only edits. Comments are not
 * schema. This wrapper:
 *
 *   1. Normalizes every migration (normalize-sql.mjs: full-line comments
 *      stripped, blank runs collapsed) into a temp dir and points the tool
 *      at that dir, so checksums are computed over normalized content.
 *   2. Upgrades pre-existing `_migrations` rows that were hashed over raw
 *      content. A row upgrades automatically ONLY when its stored checksum
 *      matches md5(raw current file) — proof the file on disk is exactly what
 *      was applied. Otherwise the version must be listed in
 *      CH_MIGRATIONS_REBASELINE_VERSIONS (comma-separated) to re-baseline;
 *      anything else fails, preserving real drift detection.
 *
 * Usage: node clickhouse/migrate.mjs --host=... --user=... --password=... \
 *          --db=... --migrations-home=./clickhouse/migrations
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createClient } from '@clickhouse/client';
import { normalizeSql } from './normalize-sql.mjs';

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { host, user, password, db, 'migrations-home': migrationsHome } = args;
  if (!host || !db || !migrationsHome) {
    console.error('usage: migrate.mjs --host=<url> --user=<u> --password=<p> --db=<db> --migrations-home=<dir>');
    process.exit(1);
  }

  const files = fs
    .readdirSync(migrationsHome)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));

  // 1. Normalized copies for the tool to hash and apply.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-migrations-normalized-'));
  const byVersion = new Map();
  for (const f of files) {
    const version = parseInt(f);
    const existing = byVersion.get(version);
    if (existing) {
      // Two files sharing a version would silently shadow each other here and
      // surface downstream as a bogus "content drifted" failure against
      // whichever one was applied first.
      console.error(
        `[migrate] duplicate migration version ${version}: ${existing.file} and ${f} — renumber one of them`,
      );
      process.exit(1);
    }
    const raw = fs.readFileSync(path.join(migrationsHome, f), 'utf8');
    const normalized = normalizeSql(raw);
    fs.writeFileSync(path.join(tmpDir, f), normalized);
    byVersion.set(version, { file: f, rawHash: md5(raw), normHash: md5(normalized) });
  }

  // 2. Upgrade legacy (raw-hashed) rows in _migrations, if the table exists.
  const client = createClient({
    url: host,
    username: user ?? 'default',
    password: password ?? '',
    database: db,
  });
  const rebaselineAllowed = new Set(
    (process.env.CH_MIGRATIONS_REBASELINE_VERSIONS ?? '')
      .split(',')
      .map((s) => parseInt(s.trim()))
      .filter((n) => Number.isFinite(n)),
  );

  const tableExists = await client.query({
    query: `SELECT 1 FROM system.tables WHERE database = {db:String} AND name = '_migrations'`,
    query_params: { db },
    format: 'JSONEachRow',
  });
  if ((await tableExists.json()).length > 0) {
    const res = await client.query({
      query: 'SELECT version, argMax(checksum, applied_at) AS checksum, argMax(migration_name, applied_at) AS migration_name FROM _migrations GROUP BY version',
      format: 'JSONEachRow',
    });
    const applied = await res.json();
    const failures = [];
    for (const row of applied) {
      const version = Number(row.version);
      const local = byVersion.get(version);
      if (!local) continue; // upstream tool reports removed files itself
      if (row.checksum === local.normHash) continue; // already normalized-format
      let reason;
      if (row.checksum === local.rawHash) {
        reason = 'raw checksum matches file on disk';
      } else if (rebaselineAllowed.has(version)) {
        reason = 'explicitly allow-listed via CH_MIGRATIONS_REBASELINE_VERSIONS';
      } else {
        failures.push(`${row.migration_name} (version ${version})`);
        continue;
      }
      console.log(`[migrate] re-baselining checksum for ${local.file}: ${reason}`);
      await client.command({
        query: `ALTER TABLE _migrations UPDATE checksum = {checksum:String} WHERE version = {version:UInt32}`,
        query_params: { checksum: local.normHash, version },
        clickhouse_settings: { mutations_sync: '2' },
      });
    }
    if (failures.length > 0) {
      console.error(
        `[migrate] applied migration content drifted (not comment-only, or comment shares a line with code):\n` +
          failures.map((f) => `  - ${f}`).join('\n') +
          `\nRestore the file content, or if the drift is intentional and verified, allow-list the version in CH_MIGRATIONS_REBASELINE_VERSIONS.`,
      );
      process.exit(1);
    }
  }
  await client.close();

  // 3. Run the real tool against the normalized copies. Resolve its CLI
  // through module resolution — the .bin shim location varies with
  // workspace hoisting.
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('clickhouse-migrations/package.json')), 'lib', 'cli.js');
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'migrate',
      `--host=${host}`,
      `--user=${user ?? 'default'}`,
      `--password=${password ?? ''}`,
      `--db=${db}`,
      `--migrations-home=${tmpDir}`,
    ],
    { stdio: 'inherit' },
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (result.error) {
    console.error('[migrate] failed to spawn clickhouse-migrations:', result.error.message);
  }
  process.exit(result.status ?? 1);
}

main().catch((e) => {
  console.error('[migrate] failed:', e.message);
  process.exit(1);
});
