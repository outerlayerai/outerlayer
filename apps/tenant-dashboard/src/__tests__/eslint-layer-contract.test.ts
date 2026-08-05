import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint, type Linter } from 'eslint';
import importPlugin from 'eslint-plugin-import';

// These tests exercise the SHIPPED eslint.config.mjs, not a hand-copied ruleset:
// each fixture is linted through the real config so a rule that silently stops
// firing (or starts over-firing) fails here. The only alteration is disabling the
// whole-project dead-export scan (import/no-unused-modules), which is orthogonal
// to the layer contract and would flag every fixture's export while costing
// seconds per lint.

const APP_ROOT = path.resolve(__dirname, '../..');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: APP_ROOT,
    overrideConfig: {
      plugins: { import: importPlugin as unknown as ESLint.Plugin },
      rules: { 'import/no-unused-modules': 'off' },
    },
  });
});

async function lint(code: string, relPath: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(APP_ROOT, relPath) });
  return result?.messages ?? [];
}

const idsOf = (messages: Linter.LintMessage[]): Array<string | null> =>
  messages.map((m) => m.ruleId);

// The cross-feature rule reuses the built-in no-restricted-imports id, so pin it
// by its distinctive message rather than by rule id.
const hasCrossFeatureViolation = (messages: Linter.LintMessage[]): boolean =>
  messages.some(
    (m) =>
      m.ruleId === '@typescript-eslint/no-restricted-imports' &&
      m.message.includes('Features are leaves'),
  );

describe('live-hook-fetch: use* hooks that fetch must be marked // live:', () => {
  const HOOK = 'src/lib/hooks/use-things.ts';

  it('fires when a use* hook fetches with no // live: comment', async () => {
    const ids = idsOf(
      await lint(`export function useThings() {\n  return fetch('/api/things');\n}\n`, HOOK),
    );
    expect(ids.filter((id) => id === 'local/live-hook-fetch')).toEqual(['local/live-hook-fetch']);
  });

  it('does not fire when the fetch carries a // live: <reason> comment', async () => {
    const ids = idsOf(
      await lint(
        `export function useThings() {\n  // live: onboarding trace poll advances without user action\n  return fetch('/api/things');\n}\n`,
        HOOK,
      ),
    );
    expect(ids).not.toContain('local/live-hook-fetch');
  });

  it('still fires when // live: has no reason (a bare marker does not justify)', async () => {
    const ids = idsOf(
      await lint(`export function useThings() {\n  // live:\n  return fetch('/api/things');\n}\n`, HOOK),
    );
    expect(ids).toContain('local/live-hook-fetch');
  });

  it('does not fire for a non-hook function that fetches', async () => {
    const ids = idsOf(
      await lint(`export function loadThings() {\n  return fetch('/api/things');\n}\n`, HOOK),
    );
    expect(ids).not.toContain('local/live-hook-fetch');
  });
});

describe('live-hook-fetch rail coverage: hooks/ subdirectories and use-*.ts files, not just hooks.ts', () => {
  it('fires for a use*.ts file directly under a feature (not named hooks.ts)', async () => {
    const ids = idsOf(
      await lint(
        `export function useThings() {\n  return fetch('/api/things');\n}\n`,
        'src/features/mine/use-things.ts',
      ),
    );
    expect(ids).toContain('local/live-hook-fetch');
  });

  it('fires for a hook inside a feature\'s hooks/ subdirectory', async () => {
    const ids = idsOf(
      await lint(
        `export function useThings() {\n  return fetch('/api/things');\n}\n`,
        'src/features/mine/hooks/use-things.ts',
      ),
    );
    expect(ids).toContain('local/live-hook-fetch');
  });

  it('fires for a hook nested under a feature\'s components/ directory (use-*.ts anywhere in the feature)', async () => {
    const ids = idsOf(
      await lint(
        `export function useThings() {\n  return fetch('/api/things');\n}\n`,
        'src/features/mine/components/history/use-things.ts',
      ),
    );
    expect(ids).toContain('local/live-hook-fetch');
  });
});

describe('live-hook-fetch rail coverage: a Supabase query chain is a recognized live callee', () => {
  const HOOK = 'src/features/mine/use-things.ts';

  it('fires on a client-side `.from(...)` query chain with no // live: comment', async () => {
    const ids = idsOf(
      await lint(
        `export function useThings(supabase: any) {\n  return supabase.from('table').select('*');\n}\n`,
        HOOK,
      ),
    );
    expect(ids).toContain('local/live-hook-fetch');
  });

  it('does not fire when the `.from(...)` chain carries a // live: <reason> comment', async () => {
    const ids = idsOf(
      await lint(
        `export function useThings(supabase: any) {\n  // live: realtime-subscribed, revalidates on every INSERT\n  return supabase.from('table').select('*');\n}\n`,
        HOOK,
      ),
    );
    expect(ids).not.toContain('local/live-hook-fetch');
  });

  it('does not mistake Array.from for a Supabase query chain', async () => {
    const ids = idsOf(
      await lint(`export function useThings() {\n  return Array.from([1, 2]);\n}\n`, HOOK),
    );
    expect(ids).not.toContain('local/live-hook-fetch');
  });
});

describe('use-server-export-authorized: "use server" exports must be authorizedAction()', () => {
  const ACTIONS = 'src/features/things/actions.ts';

  it('fires on a raw exported server action', async () => {
    const ids = idsOf(await lint(`'use server';\nexport async function doThing() {}\n`, ACTIONS));
    expect(ids).toContain('local/use-server-export-authorized');
  });

  it('does not fire when every export wraps authorizedAction()', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nimport { authorizedAction } from '@/lib/action-kit';\nexport const doThing = authorizedAction(async () => {});\n`,
        ACTIONS,
      ),
    );
    expect(ids).not.toContain('local/use-server-export-authorized');
  });

  it('does not fire on a raw export outside a "use server" module', async () => {
    const ids = idsOf(await lint(`export async function doThing() {}\n`, ACTIONS));
    expect(ids).not.toContain('local/use-server-export-authorized');
  });

  it('does not fire when an export wraps preTenantAction()', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nimport { preTenantAction } from '@/lib/action-kit';\nexport const doThing = preTenantAction({ reason: 'no-tenant-yet' });\n`,
        ACTIONS,
      ),
    );
    expect(ids).not.toContain('local/use-server-export-authorized');
  });

  it('still fires on a raw exported arrow const — a call to an unrelated function is not mistaken for a wrapper', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nexport const doThing = someOtherHelper();\n`,
        ACTIONS,
      ),
    );
    expect(ids).toContain('local/use-server-export-authorized');
  });

  it('fires on a raw export alongside a valid preTenantAction export in the same module', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nimport { preTenantAction } from '@/lib/action-kit';\nexport const wrapped = preTenantAction({ reason: 'no-tenant-yet' });\nexport async function raw() {}\n`,
        ACTIONS,
      ),
    );
    expect(ids).toContain('local/use-server-export-authorized');
  });

  it('resolves a re-exported preTenantAction local binding as wrapped', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nimport { preTenantAction } from '@/lib/action-kit';\nconst helper = preTenantAction({ reason: 'no-tenant-yet' });\nexport { helper };\n`,
        ACTIONS,
      ),
    );
    expect(ids).not.toContain('local/use-server-export-authorized');
  });

  it('still fires on a re-exported plain-function local binding', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nconst helper = async () => {};\nexport { helper };\n`,
        ACTIONS,
      ),
    );
    expect(ids).toContain('local/use-server-export-authorized');
  });

  it('does not fire on a preTenantAction default export', async () => {
    const ids = idsOf(
      await lint(
        `'use server';\nimport { preTenantAction } from '@/lib/action-kit';\nexport default preTenantAction({ reason: 'no-tenant-yet' });\n`,
        ACTIONS,
      ),
    );
    expect(ids).not.toContain('local/use-server-export-authorized');
  });

  it('still fires on a raw default export', async () => {
    const ids = idsOf(
      await lint(`'use server';\nasync function doThing() {}\nexport default doThing;\n`, ACTIONS),
    );
    expect(ids).toContain('local/use-server-export-authorized');
  });
});

describe('no-server-get-session: server tiers use getUser(), not auth.getSession()', () => {
  const SERVICE = 'src/features/things/service.ts';

  it('fires on supabase.auth.getSession() in a service', async () => {
    const ids = idsOf(
      await lint(`export async function whoami(sb: any) {\n  return sb.auth.getSession();\n}\n`, SERVICE),
    );
    expect(ids).toContain('local/no-server-get-session');
  });

  it('does not fire on supabase.auth.getUser()', async () => {
    const ids = idsOf(
      await lint(`export async function whoami(sb: any) {\n  return sb.auth.getUser();\n}\n`, SERVICE),
    );
    expect(ids).not.toContain('local/no-server-get-session');
  });

  it('does not fire on an unrelated .getSession() that is not on auth', async () => {
    const ids = idsOf(
      await lint(`export function read(store: any) {\n  return store.getSession();\n}\n`, SERVICE),
    );
    expect(ids).not.toContain('local/no-server-get-session');
  });
});

describe('no-shared-use-cache: "use cache" is allowed only under lib/static-cache', () => {
  it('fires on a "use cache" directive outside lib/static-cache', async () => {
    const ids = idsOf(await lint(`'use cache';\nexport const x = 1;\n`, 'src/lib/misc.ts'));
    expect(ids).toContain('local/no-shared-use-cache');
  });

  it('does not fire under src/lib/static-cache', async () => {
    const ids = idsOf(await lint(`'use cache';\nexport const x = 1;\n`, 'src/lib/static-cache/misc.ts'));
    expect(ids).not.toContain('local/no-shared-use-cache');
  });

  it('does not fire on a file without the directive', async () => {
    const ids = idsOf(await lint(`export const x = 1;\n`, 'src/lib/misc.ts'));
    expect(ids).not.toContain('local/no-shared-use-cache');
  });
});

describe('legacy-world import ban resolves relative specifiers too, not just @/ aliases', () => {
  const SERVICE = 'src/features/mine/service.ts';

  it('fires on an aliased import into src/services (the existing rule)', async () => {
    const messages = await lint(
      `import { saveContextFile } from '@/services/context-save/save-service';\nexport const x = saveContextFile;\n`,
      SERVICE,
    );
    expect(messages.some((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')).toBe(true);
  });

  it('fires on a RELATIVE import that resolves into a legacy directory', async () => {
    // import/no-restricted-paths resolves the specifier to a real file to
    // determine its zone, so the fixture needs a file that exists under one
    // of the banned legacy globs (src/sections, src/services, src/auth) —
    // src/auth is the one that does.
    const messages = await lint(
      `import type { UserRole } from '../../auth/types';\nexport const x: UserRole | undefined = undefined;\n`,
      SERVICE,
    );
    expect(messages.some((m) => m.ruleId === 'import/no-restricted-paths')).toBe(true);
  });

  it('does not fire on the sanctioned lib/adapters bridge itself', async () => {
    const messages = await lint(
      `import { saveContextFile } from '@/services/context-save/save-service';\nexport const x = saveContextFile;\n`,
      'src/lib/adapters/context-save-write.ts',
    );
    expect(messages.some((m) => m.ruleId === 'import/no-restricted-paths')).toBe(false);
  });
});

describe('tenant-coherence backstop tracks membership-service.ts by its current path', () => {
  const FORBIDDEN_READ = `export function f(user) { return user.app_metadata.tenant_id; }\n`;

  it('fires on the app_metadata.tenant_id read at the current membership-service.ts path', async () => {
    const messages = await lint(FORBIDDEN_READ, 'src/lib/system/membership-service.ts');
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('does not fire at the old (pre-relocation) path — the allowlist entry moved, it was not duplicated', async () => {
    const messages = await lint(FORBIDDEN_READ, 'src/services/membership/membership-service.ts');
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(false);
  });
});

describe('membership-service.ts is the only lib/system file allowed to reach the EE app-access service', () => {
  const IMPORT_EE_APP_ACCESS = `import { AppMemberRoleService } from '@ee/features/app-access/app-member-role-service';\nexport const x = AppMemberRoleService;\n`;

  it('does not fire at membership-service.ts — the documented one-way EE crossing', async () => {
    const messages = await lint(IMPORT_EE_APP_ACCESS, 'src/lib/system/membership-service.ts');
    expect(hasCrossFeatureViolation(messages)).toBe(false);
  });

  it('still fires for every other lib/system file — the exception is scoped to one file, not the whole tier', async () => {
    const messages = await lint(IMPORT_EE_APP_ACCESS, 'src/lib/system/health.ts');
    expect(hasCrossFeatureViolation(messages)).toBe(true);
  });

  it('still fires for a DIFFERENT ee/features/* target from membership-service.ts — the exception names one import, not the whole EE group', async () => {
    const messages = await lint(
      `import { x } from '@ee/features/sso/service';\nexport const y = x;\n`,
      'src/lib/system/membership-service.ts',
    );
    expect(hasCrossFeatureViolation(messages)).toBe(true);
  });
});

describe('cross-feature full-leaves (D4): a feature imports no sibling feature, not even its barrel', () => {
  const SERVICE = 'src/features/mine/service.ts';

  it('fires on importing a sibling feature public entry (the tightening)', async () => {
    const messages = await lint(
      `import { thing } from '@/features/other/index';\nexport const x = thing;\n`,
      SERVICE,
    );
    expect(hasCrossFeatureViolation(messages)).toBe(true);
  });

  it('fires on importing a sibling feature internal path', async () => {
    const messages = await lint(
      `import { thing } from '@/features/other/service';\nexport const x = thing;\n`,
      SERVICE,
    );
    expect(hasCrossFeatureViolation(messages)).toBe(true);
  });

  it('does not fire on an intra-feature relative import', async () => {
    const messages = await lint(
      `import { thing } from './helpers';\nexport const x = thing;\n`,
      SERVICE,
    );
    expect(hasCrossFeatureViolation(messages)).toBe(false);
  });
});
