#!/usr/bin/env node
// Migration version-collision gate.
//
// Supabase tracks applied migrations by the numeric prefix of the filename
// alone, and that column is the primary key:
//
//   Table "supabase_migrations.schema_migrations"
//   Indexes: "schema_migrations_pkey" PRIMARY KEY, btree (version)
//
// Two files sharing a prefix therefore cannot both be recorded, no matter that
// their names and contents differ. One of them ends up untracked, and which one
// depends on filename sort order.
//
// The collision this catches is invisible to a single branch: two open PRs each
// add 20260728163000_*.sql, each is internally consistent, and git merges both
// without conflict because the paths differ. It only exists in the merged tree.
// That is why this runs over the whole directory rather than the PR's changed
// files, and why it belongs in an always-on job — on a pull_request event
// actions/checkout resolves the merge ref, so the tree seen here is base+head,
// where the duplicate is visible.
//
// Note the residual window this does NOT close: if the colliding PR merges
// AFTER this gate ran, the green result is stale. Requiring branches to be
// up to date before merging (or a merge queue) is what closes that.
//
//   node scripts/ci/check-migration-versions.mjs
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot =
  process.env.MIGRATION_VERSIONS_CWD ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// `pattern` must capture the version in group 1. Supabase uses a fixed 14-digit
// UTC timestamp; ClickHouse uses a plain incrementing integer.
const TARGETS = [
  {
    dir: "apps/tenant-dashboard/supabase/migrations",
    pattern: /^(\d{14})_.+\.sql$/,
    shape: "<14-digit timestamp>_<name>.sql",
  },
  {
    dir: "apps/tenant-dashboard/clickhouse/migrations",
    pattern: /^(\d+)_.+\.sql$/,
    shape: "<number>_<name>.sql",
    // 07_x and 7_x are the same migration to a numeric runner; compare by value.
    normalize: (v) => String(Number(v)),
  },
];

const errors = [];

for (const { dir, pattern, shape, normalize = (v) => v } of TARGETS) {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, dir));
  } catch {
    errors.push(`${dir}: directory not found`);
    continue;
  }

  const files = entries.filter((f) => f.endsWith(".sql")).sort();
  const byVersion = new Map();

  for (const file of files) {
    const match = pattern.exec(file);
    if (!match) {
      errors.push(`${dir}/${file}: filename does not match ${shape}`);
      continue;
    }
    const version = normalize(match[1]);
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(file);
  }

  for (const [version, owners] of byVersion) {
    if (owners.length > 1) {
      errors.push(
        `${dir}: version ${version} claimed by ${owners.length} files — ` +
          `only one can ever be recorded as applied:\n` +
          owners.map((f) => `    ${f}`).join("\n"),
      );
    }
  }
}

if (errors.length > 0) {
  console.error("::error::Migration version check failed\n");
  for (const error of errors) console.error(`  ${error}`);
  console.error(
    "\nFix: renumber the newer migration to an unused, later version. Safe to " +
      "rename while it is still unapplied everywhere; once an environment has " +
      "recorded the old version, renaming makes it replay.",
  );
  process.exit(1);
}

console.log("✓ Migration versions are unique and well-formed");
