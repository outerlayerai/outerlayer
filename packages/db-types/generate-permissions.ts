/**
 * Generator for the single permission source of truth.
 *
 * Input:  permission-seed.json (this directory) — per built-in-role grants,
 *         grouped, each group carrying a present-tense rationale.
 * Output: (a) the GENERATED role_permissions block inside
 *             apps/tenant-dashboard/supabase/schemas/12-rbac.sql (the reviewable
 *             declarative source the migration is derived from), and
 *         (b) permissions.ts (this directory) — APP_PERMISSIONS catalog +
 *             BUILT_IN_ROLE_PERMISSIONS map, both satisfies-checked against the
 *             generated app_permission enum.
 *
 * Run `yarn codegen:permissions` from apps/tenant-dashboard after editing the
 * seed. CI re-runs it and fails on any drift (byte-exact), the same discipline
 * as the generated db-types check — hand-editing a generated region is rejected.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Constants } from './index';

const HERE = __dirname;
const REPO_ROOT = join(HERE, '..', '..');
const SEED_PATH = join(HERE, 'permission-seed.json');
const TS_OUT = join(HERE, 'permissions.ts');
const RBAC_SQL = join(
  REPO_ROOT,
  'apps',
  'tenant-dashboard',
  'supabase',
  'schemas',
  '12-rbac.sql',
);

const BEGIN =
  '-- BEGIN GENERATED role_permissions — source: packages/db-types/permission-seed.json';
const END = '-- END GENERATED role_permissions';

const BUILT_IN_ROLES = ['owner', 'admin', 'write', 'read'] as const;
type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

interface Group {
  key: string;
  rationale: string;
  grants: Record<string, string[]>;
}
interface Seed {
  roles: string[];
  groups: Group[];
  /** Enum values deliberately granted to no role, each with a reason. */
  intentionally_unseeded: Record<string, string>;
}

function loadSeed(): Seed {
  const seed: Seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const enumPerms = new Set<string>(Constants.public.Enums.app_permission);

  if (
    seed.roles.length !== BUILT_IN_ROLES.length ||
    seed.roles.some((r, i) => r !== BUILT_IN_ROLES[i])
  ) {
    throw new Error(
      `permission-seed.json roles must be exactly ${JSON.stringify(BUILT_IN_ROLES)} in order`,
    );
  }

  const seenGroups = new Set<string>();
  const seenPerms = new Set<string>();
  for (const g of seed.groups) {
    if (!g.rationale?.trim()) throw new Error(`group "${g.key}" is missing a rationale`);
    if (seenGroups.has(g.key)) throw new Error(`duplicate group key: ${g.key}`);
    seenGroups.add(g.key);
    for (const [perm, roles] of Object.entries(g.grants)) {
      if (!enumPerms.has(perm)) {
        throw new Error(`seed grants a permission absent from the app_permission enum: ${perm}`);
      }
      if (seenPerms.has(perm)) throw new Error(`permission appears in two groups: ${perm}`);
      seenPerms.add(perm);
      if (roles.length === 0) throw new Error(`permission "${perm}" grants no roles`);
      const seenRole = new Set<string>();
      for (const role of roles) {
        if (!BUILT_IN_ROLES.includes(role as BuiltInRole)) {
          throw new Error(`permission "${perm}" grants unknown role: ${role}`);
        }
        if (seenRole.has(role)) throw new Error(`permission "${perm}" repeats role: ${role}`);
        seenRole.add(role);
      }
      // Canonical role order keeps the emitted artifacts stable across edits.
      const ordered = [...roles].sort(
        (a, b) => BUILT_IN_ROLES.indexOf(a as BuiltInRole) - BUILT_IN_ROLES.indexOf(b as BuiltInRole),
      );
      if (ordered.some((r, i) => r !== roles[i])) {
        throw new Error(
          `permission "${perm}" roles must be in owner>admin>write>read order; got ${roles.join(',')}`,
        );
      }
    }
  }

  // Seed-completeness invariant (owner is the top role, so it holds every
  // grantable permission): every app_permission enum value must be granted to
  // owner OR be listed in intentionally_unseeded with a reason. A new enum value
  // that is neither fails codegen here, before it can silently reach no role.
  const ownerGranted = new Set<string>();
  for (const g of seed.groups) {
    for (const [perm, roles] of Object.entries(g.grants)) {
      if (roles.includes('owner')) ownerGranted.add(perm);
    }
  }
  const unseeded = seed.intentionally_unseeded ?? {};
  for (const [perm, reason] of Object.entries(unseeded)) {
    if (!enumPerms.has(perm)) {
      throw new Error(`intentionally_unseeded lists "${perm}", which is not an app_permission value`);
    }
    if (!reason?.trim()) throw new Error(`intentionally_unseeded "${perm}" needs a reason`);
    if (ownerGranted.has(perm)) {
      throw new Error(`"${perm}" is both granted to owner and listed intentionally_unseeded`);
    }
  }
  const uncovered = [...enumPerms].filter((p) => !ownerGranted.has(p) && !(p in unseeded)).sort();
  if (uncovered.length > 0) {
    throw new Error(
      `these app_permission values are granted to no role and are not in intentionally_unseeded:\n  ${uncovered.join('\n  ')}\n` +
        `Grant them in permission-seed.json, or add them to intentionally_unseeded with a reason.`,
    );
  }
  return seed;
}

/** Wrap a rationale into `-- ` prefixed comment lines at a 76-column margin. */
function sqlComment(text: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && `-- ${line} ${w}`.length > 76) {
      lines.push(`-- ${line}`);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(`-- ${line}`);
  return lines.join('\n');
}

function emitSqlBlock(seed: Seed): string {
  const parts: string[] = [BEGIN];
  parts.push(
    sqlComment(
      'Every row below is generated from permission-seed.json. This block is the reviewable declarative mirror of the seed; the rows are applied to the database by the role_permissions seed migrations. Edit the JSON and run `yarn codegen:permissions` — never hand-edit between the markers.',
    ),
  );
  for (const g of seed.groups) {
    const rows: string[] = [];
    for (const [perm, roles] of Object.entries(g.grants)) {
      for (const role of roles) rows.push(`    ('${role}', '${perm}')`);
    }
    parts.push('');
    parts.push(sqlComment(g.rationale));
    parts.push('INSERT INTO public.role_permissions (role, permission) VALUES');
    parts.push(rows.join(',\n'));
    parts.push('ON CONFLICT (role, permission) DO NOTHING;');
  }
  parts.push(END);
  return parts.join('\n');
}

function emitTsModule(seed: Seed): string {
  const allPerms = new Set<string>();
  const byRole: Record<BuiltInRole, string[]> = { owner: [], admin: [], write: [], read: [] };
  for (const g of seed.groups) {
    for (const [perm, roles] of Object.entries(g.grants)) {
      allPerms.add(perm);
      for (const role of roles) byRole[role as BuiltInRole].push(perm);
    }
  }
  const catalog = [...allPerms].sort();
  const list = (perms: string[]) =>
    [...perms].sort().map((p) => `  '${p}',`).join('\n');

  return `// GENERATED by codegen:permissions from permission-seed.json — do not edit.
//
// One source for the built-in-role permission knowledge that the dashboard and
// gateway share. Custom-role permissions are user-defined runtime DB rows and
// are NOT represented here. Gateway API-key roles are a separate axis
// (packages/gateway-core/src/lib/permissions.ts) and are likewise not here.
import type { Database } from './index';

type AppPermission = Database['public']['Enums']['app_permission'];
type BuiltInRole = 'owner' | 'admin' | 'write' | 'read';

/** Every permission granted to at least one built-in role (the active catalog). */
export const APP_PERMISSIONS = [
${list(catalog)}
] as const satisfies readonly AppPermission[];

/** Built-in app_role → the exact permission set the role holds. */
export const BUILT_IN_ROLE_PERMISSIONS = {
  owner: [
${list(byRole.owner).replace(/^/gm, '  ')}
  ],
  admin: [
${list(byRole.admin).replace(/^/gm, '  ')}
  ],
  write: [
${list(byRole.write).replace(/^/gm, '  ')}
  ],
  read: [
${list(byRole.read).replace(/^/gm, '  ')}
  ],
} as const satisfies Record<BuiltInRole, readonly AppPermission[]>;

/**
 * Enum values deliberately granted to no role (dropped tables kept for enum
 * compatibility, plus permissions with no consumer). The seed-completeness
 * invariant requires every app_permission to be here or granted to owner.
 */
export const INTENTIONALLY_UNSEEDED = [
${list(Object.keys(seed.intentionally_unseeded))}
] as const satisfies readonly AppPermission[];
`;
}

function replaceGeneratedRegion(source: string, block: string): string {
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `12-rbac.sql is missing the ${BEGIN} / ${END} markers — add them where the seed block belongs.`,
    );
  }
  const before = source.slice(0, beginIdx);
  const after = source.slice(endIdx + END.length);
  return `${before}${block}${after}`;
}

function main(): void {
  const seed = loadSeed();
  // The generated region's INPUT is always the canonical schema file (read only),
  // but the OUTPUT paths can be redirected to a scratch location. The byte-exact
  // check uses that to generate into a temp dir and compare, so a running check
  // never writes — let alone truncates — the checked-in files a sibling gate may
  // be reading concurrently.
  const sqlOut = process.env.PERMISSION_CODEGEN_SQL_OUT || RBAC_SQL;
  const tsOut = process.env.PERMISSION_CODEGEN_TS_OUT || TS_OUT;
  const sql = readFileSync(RBAC_SQL, 'utf8');
  writeFileSync(sqlOut, replaceGeneratedRegion(sql, emitSqlBlock(seed)));
  writeFileSync(tsOut, emitTsModule(seed));
  const rows = seed.groups.reduce(
    (n, g) => n + Object.values(g.grants).reduce((m, r) => m + r.length, 0),
    0,
  );
  console.log(
    `codegen:permissions — ${seed.groups.length} groups, ${rows} role_permissions rows emitted`,
  );
}

main();
