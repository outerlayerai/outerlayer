import { cleanupTestUsers } from '../../lib/test-utils';
import { ensureDefaultEnvironment } from '../../lib/environment-test-utils';
import {
  createTestUser,
  createTestData,
  testPermission,
  testResourceAccess,
  testSelfProfileUpdate,
  testCrossProfileUpdateBlocked,
  testProfileDeletionBlocked,
  getProfileTests,
  ProfileTestConfig,
  ResourceType,
  Role,
  TestUser,
} from '../../lib/rbac-test-utils';

/**
 * Parameterized RBAC matrix: per-role resource access plus cross-resource
 * permission-RPC assertions, covering every active role in one file.
 *
 * Each role declares:
 *   - A profile config (for getProfileTests + security helpers)
 *   - A sparse resource matrix (resource × operation → expectation)
 *   - Extra permission-RPC assertions (for cross-resource permissions)
 *
 * Adding a new role = add one entry to ROLE_CONFIGS. No new file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Expectation = 'allow' | 'deny-rls' | 'deny-perm' | 'empty-ok';

type RoleMatrix = Partial<Record<ResourceType, {
  select?: Expectation;
  insert?: Expectation;
  update?: Expectation;
  delete?: Expectation;
}>>;

interface ResourceSpec {
  /** Produces insert data with a unique marker for this test instance. */
  insertData: (opts: InsertOpts) => Record<string, unknown>;
  /** Produces an update patch. */
  updatePatch: (opts: { marker: string }) => Record<string, unknown>;
  /** Where-clause filter that matches a row produced by insertData. */
  whereByMarker: (marker: string) => Record<string, unknown>;
  /**
   * Some tables have UNIQUE(app_id, tenant_id); update/delete tests for those
   * need a fresh app so they don't collide with the insert run a moment earlier.
   */
  needsFreshAppPerTest?: boolean;
  /**
   * Column list for SELECT tests, forwarded to `testResourceAccess`. Omit for
   * an ordinary table (defaults to `'*'`). Required for a column-scoped table
   * (`authenticated` has per-column GRANTs, e.g. `git_connection`) — `'*'`
   * there is an unconditional privilege error, not an RLS signal, so it would
   * fail every case in this matrix regardless of the expectation.
   */
  selectColumns?: string;
}

interface InsertOpts {
  appId: string;
  tenantId: string;
  marker: string;
  /**
   * The app's default environment id. Required for `api_key` inserts whose
   * `environment_id` column is NOT NULL.
   */
  environmentId: string;
}

interface RoleConfig {
  role: Role;
  displayName: string;
  profileConfig: ProfileTestConfig;
  matrix: RoleMatrix;
}

interface CrossRolePermission {
  permission: string;
  /** If a role is missing from the map, the test is skipped for that role. */
  allowedBy: Partial<Record<Role, boolean>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-resource shape registry
// ─────────────────────────────────────────────────────────────────────────────

const RESOURCE_SPECS: Partial<Record<ResourceType, ResourceSpec>> = {
  app: {
    insertData: ({ marker }) => ({ name: `App ${marker}` }),
    updatePatch: ({ marker }) => ({ name: `App ${marker} updated` }),
    whereByMarker: (marker) => ({ name: `App ${marker}` }),
  },
  api_key: {
    insertData: ({ appId, environmentId, marker }) => ({
      name: `Key ${marker}`,
      api_key_id: `key-${marker}`,
      app_id: appId,
      environment_id: environmentId,
    }),
    updatePatch: ({ marker }) => ({ name: `Key ${marker} updated` }),
    whereByMarker: (marker) => ({ name: `Key ${marker}` }),
  },
  tenant: {
    insertData: ({ marker }) => ({ organization_name: `Org ${marker}` }),
    updatePatch: ({ marker }) => ({ organization_name: `Org ${marker} updated` }),
    whereByMarker: (marker) => ({ organization_name: `Org ${marker}` }),
  },
  billing: {
    insertData: ({ marker }) => ({ stripe_customer_id: `cus-${marker}` }),
    updatePatch: ({ marker }) => ({ stripe_customer_id: `cus-${marker}-updated` }),
    whereByMarker: (marker) => ({ stripe_customer_id: `cus-${marker}` }),
  },
  git_connection: {
    insertData: ({ appId, marker }) => ({ app_id: appId, repository: `test/repo-${marker}` }),
    updatePatch: ({ marker }) => ({ repository: `test/repo-${marker}-updated` }),
    whereByMarker: (marker) => ({ repository: `test/repo-${marker}` }),
    needsFreshAppPerTest: true,
    // `authenticated` is column-scoped, excluding the four credential
    // columns (access_token, refresh_token, webhook_secret, token_expires_at)
    // — see 22-git-connection.sql. Named here to match the grant.
    selectColumns: 'id, tenant_id, app_id, provider, repository, installation_id, webhook_id, created_at, created_by, updated_at, updated_by',
  },
  git_branch: {
    insertData: ({ appId, marker }) => ({ app_id: appId, branch_name: `branch-${marker}` }),
    updatePatch: ({ marker }) => ({ branch_name: `branch-${marker}-updated` }),
    whereByMarker: (marker) => ({ branch_name: `branch-${marker}` }),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-role matrices — what operations each role may perform on each resource.
// Sparsity is intentional: only cells that an existing test exercises are
// present. Add a cell to broaden coverage.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_MATRIX: RoleMatrix = {
  app: { select: 'allow', insert: 'allow', update: 'allow', delete: 'allow' },
  api_key: { select: 'allow', insert: 'allow', update: 'allow', delete: 'allow' },
  tenant: { select: 'allow', insert: 'deny-rls', update: 'allow', delete: 'allow' },
  billing: { select: 'allow', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
  git_connection: { select: 'allow', insert: 'allow', update: 'allow', delete: 'allow' },
  git_branch: { select: 'allow', insert: 'allow', update: 'allow', delete: 'allow' },
};

const ADMIN_MATRIX: RoleMatrix = {
  app: { select: 'allow', insert: 'allow', update: 'allow', delete: 'allow' },
  api_key: { select: 'allow', insert: 'allow', update: 'allow', delete: 'allow' },
  tenant: { select: 'allow', insert: 'deny-rls', update: 'allow', delete: 'allow' },
  billing: { select: 'allow', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
  git_connection: { select: 'allow', insert: 'allow' },
  git_branch: { select: 'allow', insert: 'allow' },
};

const WRITE_MATRIX: RoleMatrix = {
  api_key: { select: 'allow', insert: 'allow', update: 'deny-rls', delete: 'deny-rls' },
  app: { select: 'allow', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
  git_connection: { select: 'allow', insert: 'allow', delete: 'deny-rls' },
  git_branch: { select: 'allow', insert: 'deny-rls' },
  tenant: { select: 'allow', insert: 'deny-rls', update: 'allow', delete: 'allow' },
  billing: { select: 'allow', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
};

const READ_MATRIX: RoleMatrix = {
  app: { select: 'allow', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
  git_connection: { select: 'allow', insert: 'deny-rls' },
  git_branch: { select: 'allow', insert: 'deny-rls' },
  tenant: { select: 'allow', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
  // `read` returns empty set on api_key (RLS hides rows) rather than erroring.
  api_key: { select: 'empty-ok', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
  billing: { select: 'deny-rls', insert: 'deny-rls', update: 'deny-rls', delete: 'deny-rls' },
};

const DISABLED_MATRIX: RoleMatrix = {
  app: { select: 'deny-perm', insert: 'deny-rls' },
  api_key: { select: 'deny-rls' },
  billing: { select: 'deny-rls' },
  git_connection: { select: 'deny-rls' },
  git_branch: { select: 'deny-rls' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-role profile configs
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_OWNER: ProfileTestConfig = {
  role: 'owner',
  canRead: true,
  canCreate: false,
  canUpdate: true,
  canDelete: false,
  canUpdateOwnProfile: true,
  canUpdateOtherProfiles: false,
  expectedCreateError: 'row-level security policy',
  expectedDeleteError: 'permission denied',
};

const PROFILE_ADMIN: ProfileTestConfig = { ...PROFILE_OWNER, role: 'admin' };
const PROFILE_WRITE: ProfileTestConfig = { ...PROFILE_OWNER, role: 'write' };
const PROFILE_READ: ProfileTestConfig = { ...PROFILE_OWNER, role: 'read' };

const PROFILE_DISABLED: ProfileTestConfig = {
  role: 'disabled',
  canRead: true,
  canCreate: false,
  canUpdate: false,
  canDelete: false,
  canUpdateOwnProfile: true,
  canUpdateOtherProfiles: false,
  expectedCreateError: 'row-level security policy',
  expectedUpdateError: 'permission denied',
  expectedDeleteError: 'permission denied',
};

// ─────────────────────────────────────────────────────────────────────────────
// Cross-role permission RPC matrix
// ─────────────────────────────────────────────────────────────────────────────

const CROSS_ROLE_PERMISSIONS: CrossRolePermission[] = [
  // Agent-sessions actor privacy: every active role reads their OWN sessions;
  // other developers' transcripts are owner/admin only. Load-bearing pin —
  // the sessions surface widens to team-wide visibility if the seed ever
  // grants team.read more broadly.
  {
    permission: 'agents.sessions.self.read',
    allowedBy: { owner: true, admin: true, write: true, read: true, disabled: false },
  },
  {
    permission: 'agents.sessions.team.read',
    allowedBy: { owner: true, admin: true, write: false, read: false, disabled: false },
  },
  // Owner-only grants. Every live app_permission is seeded to owner, so the
  // narrowest boundary the authorize() RPC can express is owner-vs-admin —
  // these two are the ones the seed draws it on. Billing mutation and SSO
  // teardown are the org-destructive pair an admin must not reach, so a seed
  // that widens either to admin fails here.
  // (That no RETIRED permission is reachable is a stronger, structural claim
  // and is pinned at the enum level in
  // custom-role-permission-surface-cleanup.test.ts.)
  {
    permission: 'billing.update',
    allowedBy: { owner: true, admin: false, write: false, read: false, disabled: false },
  },
  {
    permission: 'sso_config.delete',
    allowedBy: { owner: true, admin: false, write: false, read: false, disabled: false },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Role registry — add a role here, not a new file.
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_CONFIGS: RoleConfig[] = [
  { role: 'owner', displayName: 'Owner', profileConfig: PROFILE_OWNER, matrix: OWNER_MATRIX },
  { role: 'admin', displayName: 'Admin', profileConfig: PROFILE_ADMIN, matrix: ADMIN_MATRIX },
  { role: 'write', displayName: 'Write', profileConfig: PROFILE_WRITE, matrix: WRITE_MATRIX },
  { role: 'read', displayName: 'Read', profileConfig: PROFILE_READ, matrix: READ_MATRIX },
  { role: 'disabled', displayName: 'Disabled', profileConfig: PROFILE_DISABLED, matrix: DISABLED_MATRIX },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMarker(role: Role, resource: ResourceType, op: string): string {
  return `${role}-${resource}-${op}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// App-scoped resources whose read visibility flows through the set-based
// `app_id IN (SELECT private.authorized_app_ids(<perm>))` policy. For these a
// "select allow" seeds a known row and asserts the role actually SEES it, so a
// policy that silently hides every row (e.g. gated on the wrong permission)
// fails instead of passing a bare not-errored check.
const APP_SCOPED_SELECT_PROBE = new Set<ResourceType>([
  'api_key', 'git_connection', 'git_branch',
]);

function expectationToFields(expectation: Expectation): { expectedSuccess: boolean; expectedErrorPattern?: string } {
  switch (expectation) {
    case 'allow':
    case 'empty-ok':
      return { expectedSuccess: true };
    case 'deny-rls':
      return { expectedSuccess: false, expectedErrorPattern: 'row-level security policy' };
    case 'deny-perm':
      return { expectedSuccess: false, expectedErrorPattern: 'permission denied' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The parameterized suite
// ─────────────────────────────────────────────────────────────────────────────

describe.each(ROLE_CONFIGS)('$displayName Role', (config) => {
  let user: TestUser;
  let appId: string;
  let environmentId: string;

  beforeAll(async () => {
    user = await createTestUser(config.role);

    const app = await createTestData('app', {
      name: `${config.displayName} Test App ${Date.now()}`,
      tenant_id: user.tenantId,
      created_by: user.id,
    });
    appId = app.id;

    // Api_key/deployment.environment_id is NOT NULL. The raw
    // `createTestData('app')` insert does not auto-create the default env
    // (production app-creation action does), so seed it here.
    environmentId = await ensureDefaultEnvironment(appId, user.tenantId);
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  // ── Profile management ────────────────────────────────────────────────────
  describe('Profile Management', () => {
    // There are always exactly 4 profile cases (select, insert, update, delete).
    // Using a fixed loop avoids calling the helper at collection time.
    const PROFILE_OP_LABELS = ['read', 'create', 'update', 'delete'] as const;
    PROFILE_OP_LABELS.forEach((opLabel, i) => {
      it(`${config.displayName} profile ${opLabel}`, async () => {
        const cases = getProfileTests(user, config.profileConfig);
        const c = cases[i];
        if (!c) throw new Error(`getProfileTests did not return case ${i}`);
        await testResourceAccess(user, [c]);
      });
    });

    it(`${config.displayName} should be able to update own profile`, async () => {
      await testSelfProfileUpdate(user, config.profileConfig.role);
    });

    it(`${config.displayName} should be blocked from updating another user's profile`, async () => {
      await testCrossProfileUpdateBlocked(user, config.profileConfig.role);
    });

    it(`${config.displayName} should be blocked from deleting own profile`, async () => {
      await testProfileDeletionBlocked(user);
    });
  });

  // ── Resource access matrix ────────────────────────────────────────────────
  for (const [resource, ops] of Object.entries(config.matrix) as Array<[ResourceType, NonNullable<RoleMatrix[ResourceType]>]>) {
    const spec = RESOURCE_SPECS[resource];
    if (!spec) continue;

    describe(`${resource} access`, () => {
      if (ops.select !== undefined) {
        const expectation = ops.select;
        const { expectedSuccess, expectedErrorPattern } = expectationToFields(expectation);
        it(`${config.displayName} SELECT ${resource}: ${expectation}`, async () => {
          if (expectation === 'allow' && APP_SCOPED_SELECT_PROBE.has(resource)) {
            // Seed one known row (service role) into a fresh app, then assert
            // this role sees exactly it. A fresh app keeps the row isolated from
            // the insert/update/delete tests below; the org-level member sees it
            // through authorized_app_ids over every app in the tenant.
            const marker = makeMarker(config.role, resource, 'select');
            const freshApp = await createTestData('app', {
              name: `${config.displayName} ${resource} select ${marker}`,
              tenant_id: user.tenantId,
              created_by: user.id,
            });
            const freshEnvironmentId = await ensureDefaultEnvironment(freshApp.id, user.tenantId);
            const seeded = await createTestData(resource, {
              ...spec.insertData({ appId: freshApp.id, environmentId: freshEnvironmentId, tenantId: user.tenantId, marker }),
              tenant_id: user.tenantId,
            });
            await testResourceAccess(user, [{
              table: resource,
              operation: 'select',
              where: spec.whereByMarker(marker),
              expectedSuccess,
              expectedVisibleIds: [seeded.id],
              selectColumns: spec.selectColumns,
            }]);
            return;
          }
          await testResourceAccess(user, [{
            table: resource,
            operation: 'select',
            expectedSuccess,
            expectedErrorPattern,
            selectColumns: spec.selectColumns,
          }]);
        });
      }

      if (ops.insert !== undefined) {
        const expectation = ops.insert;
        const { expectedSuccess, expectedErrorPattern } = expectationToFields(expectation);
        it(`${config.displayName} INSERT ${resource}: ${expectation}`, async () => {
          const marker = makeMarker(config.role, resource, 'insert');
          await testResourceAccess(user, [{
            table: resource,
            operation: 'insert',
            data: spec.insertData({ appId, environmentId, tenantId: user.tenantId, marker }),
            expectedSuccess,
            expectedErrorPattern,
          }]);
        });
      }

      if (ops.update !== undefined) {
        const expectation = ops.update;
        const { expectedSuccess, expectedErrorPattern } = expectationToFields(expectation);
        it(`${config.displayName} UPDATE ${resource}: ${expectation}`, async () => {
          const marker = makeMarker(config.role, resource, 'update');

          // Only prepare a fresh row when the role can actually insert. For
          // roles where insert is denied (e.g. tenant, billing for most roles),
          // any prepare would fail the test before the real update/delete runs.
          // The update/delete then runs against whatever rows the role can see;
          // for "allow" expectations this often yields a vacuous-but-valid pass
          // (zero rows matched, no error) — matching existing test behavior.
          const shouldPrepareRow = ops.insert === 'allow';

          let contextAppId = appId;
          let contextEnvironmentId = environmentId;
          if (shouldPrepareRow && spec.needsFreshAppPerTest) {
            const freshApp = await createTestData('app', {
              name: `${config.displayName} ${resource} update ${marker}`,
              tenant_id: user.tenantId,
              created_by: user.id,
            });
            contextAppId = freshApp.id;
            contextEnvironmentId = await ensureDefaultEnvironment(
              contextAppId,
              user.tenantId,
            );
          }

          if (shouldPrepareRow) {
            await testResourceAccess(user, [{
              table: resource,
              operation: 'insert',
              data: spec.insertData({ appId: contextAppId, environmentId: contextEnvironmentId, tenantId: user.tenantId, marker }),
              expectedSuccess: true,
            }]);
          }

          await testResourceAccess(user, [{
            table: resource,
            operation: 'update',
            data: spec.updatePatch({ marker }),
            where: spec.whereByMarker(marker),
            expectedSuccess,
            expectedErrorPattern,
          }]);
        });
      }

      if (ops.delete !== undefined) {
        const expectation = ops.delete;
        const { expectedSuccess, expectedErrorPattern } = expectationToFields(expectation);
        it(`${config.displayName} DELETE ${resource}: ${expectation}`, async () => {
          const marker = makeMarker(config.role, resource, 'delete');
          const shouldPrepareRow = ops.insert === 'allow';

          let contextAppId = appId;
          let contextEnvironmentId = environmentId;
          if (shouldPrepareRow && spec.needsFreshAppPerTest) {
            const freshApp = await createTestData('app', {
              name: `${config.displayName} ${resource} delete ${marker}`,
              tenant_id: user.tenantId,
              created_by: user.id,
            });
            contextAppId = freshApp.id;
            contextEnvironmentId = await ensureDefaultEnvironment(
              contextAppId,
              user.tenantId,
            );
          }

          if (shouldPrepareRow) {
            await testResourceAccess(user, [{
              table: resource,
              operation: 'insert',
              data: spec.insertData({ appId: contextAppId, environmentId: contextEnvironmentId, tenantId: user.tenantId, marker }),
              expectedSuccess: true,
            }]);
          }

          await testResourceAccess(user, [{
            table: resource,
            operation: 'delete',
            where: spec.whereByMarker(marker),
            expectedSuccess,
            expectedErrorPattern,
          }]);
        });
      }
    });
  }

  // ── Permission RPC matrix ─────────────────────────────────────────────────
  describe('Permission RPC', () => {
    for (const { permission, allowedBy } of CROSS_ROLE_PERMISSIONS) {
      const expected = allowedBy[config.role];
      if (expected === undefined) continue;
      const verb = expected ? 'has' : 'lacks';
      it(`${config.displayName} ${verb} ${permission}`, async () => {
        await expect(testPermission(user, permission)).resolves.toBe(expected);
      });
    }
  });
});
