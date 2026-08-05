#!/usr/bin/env node
/**
 * Byte-exact guard for the generated permission artifacts.
 *
 * Mirrors the Supabase Checks "generated types are checked in" discipline: the
 * role_permissions seed block in schemas/12-rbac.sql and packages/db-types/
 * permissions.ts are BOTH emitted from packages/db-types/permission-seed.json by
 * `yarn codegen:permissions`.
 *
 * The check is read-only: it regenerates into an isolated temp directory and
 * byte-compares against the checked-in files. It never writes the checked-in
 * files — a failing check must not edit the developer's tree, and pre-push gates
 * run concurrently, so a sibling gate must never observe a generated file being
 * truncated mid-write. Pass `--fix` to regenerate the checked-in files in place.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENERATED = [
  {
    path: 'apps/tenant-dashboard/supabase/schemas/12-rbac.sql',
    env: 'PERMISSION_CODEGEN_SQL_OUT',
    tmp: '12-rbac.sql',
  },
  {
    path: 'packages/db-types/permissions.ts',
    env: 'PERMISSION_CODEGEN_TS_OUT',
    tmp: 'permissions.ts',
  },
];

const GENERATOR = ['tsx', 'packages/db-types/generate-permissions.ts'];

if (process.argv.includes('--fix')) {
  execFileSync('npx', GENERATOR, { stdio: 'inherit' });
  console.log('Permission codegen regenerated in place.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'perm-codegen-'));
try {
  const env = { ...process.env };
  for (const g of GENERATED) env[g.env] = join(dir, g.tmp);
  execFileSync('npx', GENERATOR, { stdio: 'inherit', env });

  const stale = GENERATED.filter(
    (g) => readFileSync(g.path, 'utf8') !== readFileSync(join(dir, g.tmp), 'utf8'),
  );
  if (stale.length > 0) {
    console.error('\nPermission codegen is stale — these checked-in files differ from a fresh generation:');
    for (const g of stale) console.error(`  ${g.path}`);
    console.error(
      '\nEdit packages/db-types/permission-seed.json (never the generated regions), then run\n' +
        '  yarn workspace tenant-dashboard codegen:permissions\n' +
        'and commit the result.',
    );
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('Permission codegen is up to date.');
