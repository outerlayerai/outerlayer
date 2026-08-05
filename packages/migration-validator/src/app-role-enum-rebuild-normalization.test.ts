import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Rebuilding the `app_role` enum to drop a value re-types every role column by
 * casting the old value through text (`role::text::"public"."app_role"`). Any
 * row still holding the dropped value makes that cast throw at deploy time, so
 * the migration that removes a value MUST normalize the affected rows first.
 *
 * This guards the one migration that retires the `custom` sentinel: it must
 * normalize `membership`, `app_member_role`, and `role_permissions` rows before
 * the re-type. The check is content-keyed (not filename-keyed) so it survives a
 * schema-diff consolidation that renames or moves the migration, and it targets
 * only the `custom`-removal rebuild so unrelated future enum edits don't trip it.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/tenant-dashboard/supabase/migrations',
);

// The re-type that drops `custom` renames the live enum aside before recreating
// it; pairing this marker with a `custom`-free recreation pins the exact
// migration and excludes the original `app_role` creation.
const RENAME_ASIDE =
  /alter\s+type\s+"public"\."app_role"\s+rename\s+to\s+"app_role__old_version_to_be_dropped"/i;
const CREATE_APP_ROLE =
  /create\s+type\s+"public"\."app_role"\s+as\s+enum\s*\(([^)]*)\)/i;

// First column re-type onto the rebuilt enum — everything normalizing `custom`
// rows has to happen before this index.
const FIRST_RETYPE =
  /alter\s+table[\s\S]*?alter\s+column\s+role\s+type\s+(?:"public"\.)?"?app_role"?/i;

const MEMBERSHIP_NORMALIZE =
  /update\s+(?:"?public"?\.)?"?membership"?\s+set\s+role\s*=\s*'read'[\s\S]*?where\s+role[\s\S]*?'custom'/i;
const APP_MEMBER_ROLE_NORMALIZE =
  /update\s+(?:"?public"?\.)?"?app_member_role"?\s+set\s+role\s*=\s*'read'[\s\S]*?where\s+role[\s\S]*?'custom'/i;
const ROLE_PERMISSIONS_NORMALIZE =
  /delete\s+from\s+(?:"?public"?\.)?"?role_permissions"?[\s\S]*?where\s+role[\s\S]*?'custom'/i;

function findCustomRemovalRebuild(): string | null {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (!RENAME_ASIDE.test(content)) continue;
    const recreate = content.match(CREATE_APP_ROLE);
    if (!recreate) continue;
    const values = recreate[1];
    if (/'custom'/i.test(values)) continue; // still keeps custom — not the retirement
    return content;
  }
  return null;
}

describe('app_role enum rebuild', () => {
  const rebuild = findCustomRemovalRebuild();

  it('normalizes custom rows before re-typing role columns onto the rebuilt enum', () => {
    // No migration currently drops `custom` from the enum — nothing to guard.
    if (rebuild === null) return;

    const membershipIdx = rebuild.search(MEMBERSHIP_NORMALIZE);
    const appMemberRoleIdx = rebuild.search(APP_MEMBER_ROLE_NORMALIZE);
    const rolePermissionsIdx = rebuild.search(ROLE_PERMISSIONS_NORMALIZE);
    const retypeIdx = rebuild.search(FIRST_RETYPE);

    // All three normalization statements are present.
    expect(membershipIdx).toBeGreaterThanOrEqual(0);
    expect(appMemberRoleIdx).toBeGreaterThanOrEqual(0);
    expect(rolePermissionsIdx).toBeGreaterThanOrEqual(0);
    expect(retypeIdx).toBeGreaterThanOrEqual(0);

    // Each normalization runs before the first cast onto the rebuilt enum.
    expect(membershipIdx).toBeLessThan(retypeIdx);
    expect(appMemberRoleIdx).toBeLessThan(retypeIdx);
    expect(rolePermissionsIdx).toBeLessThan(retypeIdx);
  });
});
