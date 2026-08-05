/**
 * Unit Tests for CustomRoleService
 *
 * Tests validation, entitlement gating, CRUD operations,
 * and role assignment logic with mocked Supabase clients.
 *
 * Pattern: table-aware mock Supabase per the entitlement-service test pattern.
 * Framework: vitest (globals: true, vi.fn/vi.mock).
 */

// Mock server-only (required by upstream imports in entitlement-service)
vi.mock('server-only', () => ({}));

// Mock EntitlementService to control the entitlement gate.
// The source code uses `new EntitlementService(...)` so the mock must be a constructor.
// We use a variable so tests can reconfigure `canAccess` per test case.
let mockCanAccess = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/system/entitlement-service', () => ({
  EntitlementService: vi.fn().mockImplementation(function (this: any) {
    this.canAccess = mockCanAccess;
  }),
  buildDeniedInfo: vi.fn().mockReturnValue({
    featureKey: 'custom_roles',
    featureDisplayName: 'Custom Roles',
    requiredTier: 'team',
    requiredTierDisplayName: 'Team',
    isSelfServe: true,
    pricing: null,
    upgradeUrl: '/settings/billing',
  }),
}));

const mockLogServerError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/adapters', () => ({ logServerError: mockLogServerError }));

import type { Mock } from 'vitest';
import { CustomRoleService } from './custom-role-service';

// ============================================================================
// Mock Supabase Helpers
// ============================================================================

/**
 * Creates a chainable mock that resolves at a terminal method.
 * Terminal methods: .single(), .maybeSingle(), or the chain itself (for insert/delete without terminal).
 */
function createChain(resolveValue: { data?: unknown; error?: unknown; count?: number | null } = { data: null, error: null }) {
  const chain: Record<string, Mock> = {};

  // Terminal methods
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);

  // Chainable methods return the chain
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);

  // For select('*', { count: 'exact', head: true }) which resolves to { count }
  // Make the chain itself thenable so await on the chain resolves
  chain.then = vi.fn((resolve: (val: unknown) => void) => {
    return Promise.resolve(resolveValue).then(resolve);
  });

  return chain;
}

/**
 * Creates a mock Supabase client with table-aware handlers.
 * Each table name maps to a chain with specific resolved values.
 */
function createMockSupabase(handlers: Record<string, ReturnType<typeof createChain>> = {}) {
  return {
    from: vi.fn((table: string) => handlers[table] ?? createChain()),
  } as any;
}

// ============================================================================
// Test Data Factories
// ============================================================================

function makeRole(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'role-1',
    tenant_id: 'tenant-1',
    name: 'Test-Role',
    description: null,
    created_at: '2025-01-01T00:00:00Z',
    created_by: null,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('CustomRoleService', () => {
  const TENANT_ID = 'tenant-1';

  // Reset mocks before each test to avoid cross-contamination
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: entitlement allowed
    mockCanAccess = vi.fn().mockResolvedValue(true);
  });

  // --------------------------------------------------------------------------
  // create()
  // --------------------------------------------------------------------------

  describe('create()', () => {
    it('should return validation error when name is empty', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: '',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('Role name is required');
      }
    });

    it('should return validation error when name exceeds 100 characters', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'a'.repeat(101),
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('100 characters or less');
      }
    });

    it('should surface the EXACT validation message (not the ZodError JSON blob) when name is empty', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: '',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        // Exact equality, not `.toContain`. If zodErrorMessage's
        // `e instanceof z.ZodError` conditional is flipped so it falls through
        // to `e.message`, the value becomes the serialized issues JSON — which
        // still *contains* this substring but is not equal to it. This kills
        // the L70 conditional survivor that a `.toContain` assertion misses.
        expect(failed.error).toBe('Role name is required');
      }
    });

    it('should return validation error when permissions array is empty', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'Valid-Name',
        permissions: [],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('At least one permission is required');
      }
    });

    it('should return entitlement_denied when entitlement check fails', async () => {
      mockCanAccess = vi.fn().mockResolvedValue(false);

      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'My-Role',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('entitlement_denied');
        expect(failed.entitlement?.requiredTier).toBe('team');
      }
    });

    it('should return error when role name already exists (unique constraint violation)', async () => {
      const adminDb = createMockSupabase();
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'Duplicate-Role',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('A role with this name already exists');
      }
    });

    it('should return generic error when role insert fails with non-duplicate error', async () => {
      const adminDb = createMockSupabase({
        custom_role: createChain({ data: null, error: null, count: 0 }),
      });
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: { code: '42000', message: 'Some DB error' } }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'New-Role',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Some DB error');
      }
    });

    it('should cleanup role when permission insert fails', async () => {
      const role = makeRole();
      const deleteChain = createChain();
      const adminDb = createMockSupabase({
        custom_role: (() => {
          // First call: count query, second call: cleanup delete
          const countChain = createChain({ data: null, error: null, count: 0 });
          // Override: the adminDb.from('custom_role') is called for count and then for delete.
          // The count chain returns 0 unconditionally, so a call counter is
          // not needed.
          return {
            select: vi.fn().mockReturnValue(countChain),
            eq: vi.fn().mockReturnValue(countChain),
            delete: vi.fn().mockReturnValue(deleteChain),
            then: vi.fn((resolve: (v: unknown) => void) =>
              Promise.resolve({ data: null, error: null, count: 0 }).then(resolve),
            ),
          } as any;
        })(),
      });

      // db: custom_role insert succeeds, custom_role_permission insert fails
      const roleInsertChain = createChain({ data: role, error: null });
      const permInsertChain = createChain({ data: null, error: { message: 'Permission insert failed' } });

      const dbFromMock = vi.fn((table: string) => {
        if (table === 'custom_role') return roleInsertChain;
        if (table === 'custom_role_permission') return permInsertChain;
        return createChain();
      });

      const db = { from: dbFromMock } as any;
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'New-Role',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Permission insert failed');
      }
      // Verify cleanup was attempted on adminDb
      expect(adminDb.from).toHaveBeenCalledWith('custom_role');
    });

    it('reports a cleanup failure through logServerError and still returns the original permission error', async () => {
      const role = makeRole();
      // Cleanup delete ALSO fails, on top of the permission insert failure.
      const deleteChain = createChain({ data: null, error: { message: 'cleanup boom' } });
      const adminDb = createMockSupabase({
        custom_role: (() => {
          const countChain = createChain({ data: null, error: null, count: 0 });
          return {
            select: vi.fn().mockReturnValue(countChain),
            eq: vi.fn().mockReturnValue(countChain),
            delete: vi.fn().mockReturnValue(deleteChain),
            then: vi.fn((resolve: (v: unknown) => void) =>
              Promise.resolve({ data: null, error: null, count: 0 }).then(resolve),
            ),
          } as any;
        })(),
      });

      const roleInsertChain = createChain({ data: role, error: null });
      const permInsertChain = createChain({ data: null, error: { message: 'Permission insert failed' } });

      const dbFromMock = vi.fn((table: string) => {
        if (table === 'custom_role') return roleInsertChain;
        if (table === 'custom_role_permission') return permInsertChain;
        return createChain();
      });

      const db = { from: dbFromMock } as any;
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'New-Role',
        permissions: ['app.read'],
      });

      // The caller still sees the permission error, not the cleanup
      // failure — a logging failure must not mask the outcome.
      expect(result).toEqual({ success: false, error: 'Permission insert failed' });
      expect(mockLogServerError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'cleanup boom' }),
        expect.objectContaining({ operation: 'CustomRoleService.create.orphanCleanup', roleId: role.id }),
      );
    });

    it('should return success with role and permissions when create succeeds', async () => {
      const role = makeRole({ id: 'role-new', name: 'Engineer' });

      const adminDb = createMockSupabase({
        custom_role: createChain({ data: null, error: null, count: 2 }),
      });

      const roleInsertChain = createChain({ data: role, error: null });
      const permInsertChain = createChain({ data: null, error: null });

      const dbFromMock = vi.fn((table: string) => {
        if (table === 'custom_role') return roleInsertChain;
        if (table === 'custom_role_permission') return permInsertChain;
        return createChain();
      });

      const db = { from: dbFromMock } as any;
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: 'Engineer',
        permissions: ['app.read', 'app.insert'],
      });

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.id).toBe('role-new');
        expect(ok.data.name).toBe('Engineer');
        expect(ok.data.permissions).toEqual(['app.read', 'app.insert']);
        expect(ok.data.memberCount).toBe(0);
      }
    });

    it('should trim whitespace from role name', async () => {
      const role = makeRole({ name: 'Trimmed-Name' });

      const adminDb = createMockSupabase({
        custom_role: createChain({ data: null, error: null, count: 0 }),
      });

      const roleInsertChain = createChain({ data: role, error: null });
      const permInsertChain = createChain({ data: null, error: null });

      const dbFromMock = vi.fn((table: string) => {
        if (table === 'custom_role') return roleInsertChain;
        if (table === 'custom_role_permission') return permInsertChain;
        return createChain();
      });

      const db = { from: dbFromMock } as any;
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.create(TENANT_ID, {
        name: '  Trimmed-Name  ',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(true);
      // Verify the insert was called with the trimmed name
      expect(roleInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Trimmed-Name' }),
      );
    });

  });

  // --------------------------------------------------------------------------
  // update()
  // --------------------------------------------------------------------------

  describe('update()', () => {
    it('should return validation error when name exceeds 100 characters', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.update(TENANT_ID, 'role-1', {
        name: 'a'.repeat(101),
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('100 characters or less');
      }
    });

    it('should return validation error when permissions array is empty', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.update(TENANT_ID, 'role-1', {
        permissions: [],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('At least one permission is required');
      }
    });

    it('should return entitlement_denied when entitlement check fails', async () => {
      mockCanAccess = vi.fn().mockResolvedValue(false);

      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.update(TENANT_ID, 'role-1', {
        name: 'Updated-Name',
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('entitlement_denied');
        expect(failed.entitlement?.requiredTier).toBe('team');
      }
    });

    it('should return error when role name already exists on update', async () => {
      const updateChain = createChain({ data: null, error: { code: '23505', message: 'duplicate key' } });
      const db = createMockSupabase({
        custom_role: updateChain,
      });
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.update(TENANT_ID, 'role-1', {
        name: 'Duplicate-Name',
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('A role with this name already exists');
      }
    });

    it('should return error when role update fails with non-duplicate error', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: { code: '42000', message: 'Update failed' } }),
      });
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.update(TENANT_ID, 'role-1', {
        name: 'New-Name',
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Update failed');
      }
    });

    it('should return error when permission replacement insert fails', async () => {
      // db.from('custom_role') for update -> success
      // db.from('custom_role_permission') for delete -> success, then insert -> error
      const roleUpdateChain = createChain({ data: null, error: null });
      const permDeleteChain = createChain({ data: null, error: null });
      const permInsertChain = createChain({ data: null, error: { message: 'Perm insert failed' } });

      let permCallCount = 0;
      const dbFromMock = vi.fn((table: string) => {
        if (table === 'custom_role') return roleUpdateChain;
        if (table === 'custom_role_permission') {
          permCallCount++;
          // First call is delete, second is insert
          if (permCallCount === 1) return permDeleteChain;
          return permInsertChain;
        }
        return createChain();
      });

      const db = { from: dbFromMock } as any;
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.update(TENANT_ID, 'role-1', {
        name: 'Updated-Role',
        permissions: ['app.read'],
      });

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Perm insert failed');
      }
    });
  });

  // --------------------------------------------------------------------------
  // delete()
  // --------------------------------------------------------------------------

  describe('delete()', () => {
    it('should succeed when role has no assigned members', async () => {
      const adminDb = createMockSupabase({
        membership: createChain({ data: null, error: null, count: 0 }),
      });
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: null }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1');

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.deleted).toBe(true);
        expect(ok.data.membersReassigned).toBe(0);
      }
    });

    it('should return error when role has members and no fallback is provided', async () => {
      const adminDb = createMockSupabase({
        membership: createChain({ data: null, error: null, count: 3 }),
      });
      const db = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('3 assigned member(s)');
        expect(failed.error).toContain('Specify a fallback role');
      }
    });

    it('should reassign members to built-in role when fallback is a built-in role', async () => {
      const membershipChain = createChain({ data: null, error: null, count: 2 });
      const adminDb = createMockSupabase({
        membership: membershipChain,
      });
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: null }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1', 'read');

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.deleted).toBe(true);
        expect(ok.data.membersReassigned).toBe(2);
      }
      // Verify update was called on membership (for reassignment)
      expect(membershipChain.update).toHaveBeenCalledWith({
        custom_role_id: null,
        role: 'read',
      });
    });

    it('should reassign members to another custom role when fallback starts with custom:', async () => {
      const membershipChain = createChain({ data: null, error: null, count: 1 });
      const adminDb = createMockSupabase({
        membership: membershipChain,
      });
      const db = createMockSupabase({
        // Must return a valid role for the fallback-role existence check in the service
        custom_role: createChain({ data: { id: 'role-2' }, error: null }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1', 'custom:role-2');

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.membersReassigned).toBe(1);
      }
      // Verify update with custom_role_id only (no role change)
      expect(membershipChain.update).toHaveBeenCalledWith({
        custom_role_id: 'role-2',
      });
    });

    it('should return error when delete query fails', async () => {
      const adminDb = createMockSupabase({
        membership: createChain({ data: null, error: null, count: 0 }),
      });
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: { message: 'Delete failed' } }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Delete failed');
      }
    });

    it('should treat null member count as 0', async () => {
      const adminDb = createMockSupabase({
        membership: createChain({ data: null, error: null, count: null }),
      });
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: null }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1');

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.membersReassigned).toBe(0);
      }
    });

    it('should reject "owner" as fallback role to prevent privilege escalation', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1', 'owner');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('Invalid fallback role');
      }
    });

    it('should reject "disabled" as fallback role', async () => {
      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.delete(TENANT_ID, 'role-1', 'disabled');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toContain('Invalid fallback role');
      }
    });
  });

  // --------------------------------------------------------------------------
  // assign()
  // --------------------------------------------------------------------------

  describe('assign()', () => {
    it('should return entitlement_denied when entitlement check fails', async () => {
      mockCanAccess = vi.fn().mockResolvedValue(false);

      const db = createMockSupabase();
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.assign(TENANT_ID, 'membership-1', 'role-1');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('entitlement_denied');
        expect(failed.entitlement?.requiredTier).toBe('team');
      }
    });

    it('should return error when role does not belong to tenant', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: null }),
      });
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.assign(TENANT_ID, 'membership-1', 'role-nonexistent');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Custom role not found in this organization');
      }
    });

    it('should succeed when role belongs to tenant', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: { id: 'role-1' }, error: null }),
      });
      const membershipChain = createChain({ data: null, error: null });
      const adminDb = createMockSupabase({
        membership: membershipChain,
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.assign(TENANT_ID, 'membership-1', 'role-1');

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.membershipId).toBe('membership-1');
        expect(ok.data.customRoleId).toBe('role-1');
      }
      // Verify the membership update
      expect(membershipChain.update).toHaveBeenCalledWith({ custom_role_id: 'role-1' });
    });

    it('should return error when membership update fails', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: { id: 'role-1' }, error: null }),
      });
      const adminDb = createMockSupabase({
        membership: createChain({ data: null, error: { message: 'FK violation' } }),
      });
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.assign(TENANT_ID, 'membership-bad', 'role-1');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('FK violation');
      }
    });
  });

  // --------------------------------------------------------------------------
  // unassign()
  // --------------------------------------------------------------------------

  describe('unassign()', () => {
    it('should succeed and return the reverted built-in role', async () => {
      // First call: select membership to get role
      // Second call: update membership to null custom_role_id
      const selectChain = createChain({ data: { role: 'member' }, error: null });
      const updateChain = createChain({ data: null, error: null });

      let callCount = 0;
      const adminDb = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            callCount++;
            if (callCount === 1) return selectChain;
            return updateChain;
          }
          return createChain();
        }),
      } as any;

      const db = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.unassign(TENANT_ID, 'membership-1');

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data.membershipId).toBe('membership-1');
        expect(ok.data.revertedToRole).toBe('member');
      }
    });

    it('should return error when membership is not found', async () => {
      const adminDb = createMockSupabase({
        membership: createChain({ data: null, error: null }),
      });
      const db = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.unassign(TENANT_ID, 'membership-nonexistent');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Membership not found');
      }
    });

    it('should return error when update to null custom_role_id fails', async () => {
      const selectChain = createChain({ data: { role: 'viewer' }, error: null });
      const updateChain = createChain({ data: null, error: { message: 'Update failed' } });

      let callCount = 0;
      const adminDb = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            callCount++;
            if (callCount === 1) return selectChain;
            return updateChain;
          }
          return createChain();
        }),
      } as any;

      const db = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.unassign(TENANT_ID, 'membership-1');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Update failed');
      }
    });
  });

  // --------------------------------------------------------------------------
  // getAll()
  // --------------------------------------------------------------------------

  describe('getAll()', () => {
    it('should return empty array when no roles exist', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: [], error: null }),
      });
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.getAll(TENANT_ID);

      expect(result.success).toBe(true);
      {
        const ok = result as Extract<typeof result, { success: true }>;
        expect(ok.data).toEqual([]);
      }
    });

    it('should return error when roles query fails', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: { message: 'Query failed' } }),
      });
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.getAll(TENANT_ID);

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Query failed');
      }
    });
  });

  // --------------------------------------------------------------------------
  // getById()
  // --------------------------------------------------------------------------

  describe('getById()', () => {
    it('should return error when role is not found', async () => {
      const db = createMockSupabase({
        custom_role: createChain({ data: null, error: { message: 'Row not found' } }),
      });
      const adminDb = createMockSupabase();
      const service = new CustomRoleService({ db, adminDb });

      const result = await service.getById(TENANT_ID, 'role-nonexistent');

      expect(result.success).toBe(false);
      {
        const failed = result as Extract<typeof result, { success: false }>;
        expect(failed.error).toBe('Row not found');
      }
    });
  });
});

// ============================================================================
// Audit trail writes — payload-exact pins
// ============================================================================

describe('CustomRoleService audit trail', () => {
  const TENANT_ID = 'tenant-1';
  const ACTOR_ID = 'actor-1';

  beforeEach(() => {
    mockCanAccess = vi.fn().mockResolvedValue(true);
  });

  /** Captures every insert into audit_log. */
  function auditCapture() {
    const rows: unknown[] = [];
    const chain = createChain({ data: null, error: null });
    chain.insert = vi.fn().mockImplementation((payload: unknown) => {
      rows.push(payload);
      return chain;
    });
    return { rows, chain };
  }

  it('create() writes an exact custom_role_created row', async () => {
    const audit = auditCapture();
    const db = createMockSupabase({
      custom_role: createChain({ data: makeRole({ name: 'Support-Role' }), error: null }),
      custom_role_permission: createChain({ data: null, error: null }),
    });
    const adminDb = createMockSupabase({ audit_log: audit.chain });
    const service = new CustomRoleService({ db, adminDb, actorId: ACTOR_ID });

    await service.create(TENANT_ID, { name: 'Support-Role', permissions: ['trace.read'] });

    expect(audit.rows).toEqual([
      {
        tenant_id: TENANT_ID,
        actor_id: ACTOR_ID,
        actor_type: 'human',
        actor_label: null,
        action_type: 'custom_role_created',
        target_type: 'custom_role',
        target_id: 'role-1',
        target_identifier: 'Support-Role',
        before_state: null,
        after_state: { name: 'Support-Role', description: null, permissions: ['trace.read'] },
        details: null,
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('update() writes before/after including the permission sets', async () => {
    const audit = auditCapture();
    const db = createMockSupabase({
      // Serves both the UPDATE await and getAll()'s roles select
      custom_role: createChain({ data: [makeRole({ name: 'Renamed-Role' })], error: null }),
      // Serves the perms delete/insert awaits and getAll()'s perms select
      custom_role_permission: createChain({
        data: [{ custom_role_id: 'role-1', permission: 'trace.read' }],
        error: null,
      }),
    });
    const adminDb = createMockSupabase({
      custom_role: createChain({ data: { name: 'Old-Role', description: 'old' }, error: null }),
      custom_role_permission: createChain({ data: [{ permission: 'app.read' }], error: null }),
      membership: createChain({ data: [], error: null }),
      audit_log: audit.chain,
    });
    const service = new CustomRoleService({ db, adminDb, actorId: ACTOR_ID });

    await service.update(TENANT_ID, 'role-1', { name: 'Renamed-Role', permissions: ['trace.read'] });

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'custom_role_updated',
        target_type: 'custom_role',
        target_id: 'role-1',
        target_identifier: 'Renamed-Role',
        before_state: { name: 'Old-Role', description: 'old', permissions: ['app.read'] },
        after_state: { name: 'Renamed-Role', description: null, permissions: ['trace.read'] },
      }),
    ]);
  });

  it('delete() writes the pre-image and reassignment details', async () => {
    const audit = auditCapture();
    const db = createMockSupabase({
      custom_role: createChain({ data: null, error: null }),
    });
    const adminDb = createMockSupabase({
      membership: createChain({ data: null, error: null, count: 0 }),
      custom_role: createChain({ data: { name: 'Doomed-Role', description: null }, error: null }),
      custom_role_permission: createChain({ data: [{ permission: 'app.read' }], error: null }),
      audit_log: audit.chain,
    });
    const service = new CustomRoleService({ db, adminDb, actorId: ACTOR_ID });

    await service.delete(TENANT_ID, 'role-1');

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'custom_role_deleted',
        target_type: 'custom_role',
        target_id: 'role-1',
        target_identifier: 'Doomed-Role',
        before_state: { name: 'Doomed-Role', description: null, permissions: ['app.read'] },
        details: { members_reassigned: 0, fallback_role: null },
      }),
    ]);
  });

  it('assign() writes a custom_role_assigned row targeting the membership', async () => {
    const audit = auditCapture();
    const db = createMockSupabase({
      custom_role: createChain({ data: { id: 'role-1', name: 'Support-Role' }, error: null }),
    });
    const adminDb = createMockSupabase({
      membership: createChain({ data: null, error: null }),
      audit_log: audit.chain,
    });
    const service = new CustomRoleService({ db, adminDb, actorId: ACTOR_ID });

    await service.assign(TENANT_ID, 'mem-1', 'role-1');

    expect(audit.rows).toEqual([
      {
        tenant_id: TENANT_ID,
        actor_id: ACTOR_ID,
        actor_type: 'human',
        actor_label: null,
        action_type: 'custom_role_assigned',
        target_type: 'membership',
        target_id: 'mem-1',
        target_identifier: null,
        before_state: null,
        after_state: { custom_role_id: 'role-1' },
        details: { custom_role_name: 'Support-Role' },
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('unassign() writes the reverted role and cleared custom role id', async () => {
    const audit = auditCapture();
    const db = createMockSupabase();
    const adminDb = createMockSupabase({
      membership: createChain({ data: { role: 'read', custom_role_id: 'role-1' }, error: null }),
      audit_log: audit.chain,
    });
    const service = new CustomRoleService({ db, adminDb, actorId: ACTOR_ID });

    await service.unassign(TENANT_ID, 'mem-1');

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'custom_role_unassigned',
        target_type: 'membership',
        target_id: 'mem-1',
        before_state: { custom_role_id: 'role-1' },
        after_state: { custom_role_id: null, role: 'read' },
      }),
    ]);
  });
});
