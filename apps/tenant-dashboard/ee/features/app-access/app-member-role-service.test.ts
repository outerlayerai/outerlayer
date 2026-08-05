/**
 * Unit tests for AppMemberRoleService.
 *
 * The EntitlementService is constructed inline inside mutation methods, so we
 * mock the module rather than injecting it. The Supabase client is injected
 * via constructor DI and is stubbed with per-table chainable mocks.
 *
 * Test categories:
 *   1. Entitlement gating (denied / allowed)
 *   2. Owner protection
 *   3. Assign flow (happy path, duplicate, DB error)
 *   4. Update role flow
 *   5. Revoke flow
 *   6. revokeAllForMembership
 *   7. Validation errors (Yup)
 *   8. Bulk assign (happy path, partial failure)
 *   9. isAppScoped query
 *  10. Query methods (getByMembership, getByApp, getAll)
 *  11. EntitlementService construction
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { AppMemberRoleService } from './app-member-role-service';
import type { AppMemberRoleRow } from '@/types/app-member-role';

// ---------------------------------------------------------------------------
// Mock EntitlementService module
// ---------------------------------------------------------------------------

const mockCanAccess = vi.fn();

vi.mock('@/lib/system/entitlement-service', () => ({
  EntitlementService: vi.fn().mockImplementation(function () {
    return { canAccess: mockCanAccess };
  }),
  buildDeniedInfo: vi.fn().mockImplementation(function (key: string) {
    return {
      featureKey: key,
      featureDisplayName: 'App-Level Roles',
      requiredTier: 'enterprise',
      requiredTierDisplayName: 'Enterprise',
      isSelfServe: false,
      pricing: 'Contact us',
      upgradeUrl: '/contact',
      currentLimit: null,
      requiredTierLimit: null,
    };
  }),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-aaa-bbb-ccc-000';
const MEMBERSHIP_ID = '11111111-1111-4111-a111-111111111111';
const APP_ID = '22222222-2222-4222-a222-222222222222';
const APP_ID_2 = '33333333-3333-4333-a333-333333333333';
const ROLE_ROW_ID = '44444444-4444-4444-a444-444444444444';
const CUSTOM_ROLE_ID = '55555555-5555-4555-a555-555555555555';

function makeMockRow(overrides: Partial<AppMemberRoleRow> = {}): AppMemberRoleRow {
  return {
    id: ROLE_ROW_ID,
    membership_id: MEMBERSHIP_ID,
    app_id: APP_ID,
    tenant_id: TENANT_ID,
    role: 'write',
    custom_role_id: null,
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Chainable Supabase mock
// ---------------------------------------------------------------------------

/**
 * Creates a chainable mock that resolves to `finalResult` when awaited.
 * Every query-builder method (select, eq, insert, etc.) returns `this`.
 * The chain is made awaitable via a `then` property.
 */
type ChainResult = { data?: unknown; error?: unknown; count?: number | null };
type AwaitableChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<ChainResult> & {
  catch: (onRejected?: (e: unknown) => unknown) => Promise<ChainResult>;
};

function createChain(finalResult: ChainResult) {
  const chain = {} as AwaitableChain;

  const methods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'order', 'limit', 'single', 'maybeSingle',
  ];

  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  // Make the chain thenable (duck-typed Promise) so `await chain` resolves.
  chain.then = ((onFulfilled?: ((v: typeof finalResult) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) =>
    Promise.resolve(finalResult).then(onFulfilled ?? undefined, onRejected ?? undefined)) as AwaitableChain['then'];

  chain.catch = ((onRejected?: ((e: unknown) => unknown) | null) =>
    Promise.resolve(finalResult).catch(onRejected ?? undefined)) as AwaitableChain['catch'];

  return chain;
}

/**
 * Builds a stubbed SupabaseClient whose `from()` dispatches to per-table
 * handlers. Each handler may be:
 *   - A static result object (used for all calls)
 *   - A function returning a chain (called per invocation, for stateful mocks)
 */
function stubDb(
  tableHandlers: Record<string, ChainResult | (() => ReturnType<typeof createChain>)> = {},
): SupabaseClient {
  const from = vi.fn((table: string) => {
    const handler = tableHandlers[table];
    if (typeof handler === 'function') return handler();
    if (handler) return createChain(handler);
    return createChain({ data: null, error: null });
  });

  return { from } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function buildService(db: SupabaseClient = stubDb()): AppMemberRoleService {
  return new AppMemberRoleService({ db });
}

function expectSuccess<T extends { success: boolean }>(
  result: T,
): Extract<T, { success: true }> {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('Expected success result');
  }
  return result as Extract<T, { success: true }>;
}

function expectFailure<T extends { success: boolean }>(
  result: T,
): Extract<T, { success: false }> {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error('Expected failure result');
  }
  return result as Extract<T, { success: false }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppMemberRoleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // 1. Entitlement gating
  // ========================================================================

  describe('entitlement gating', () => {
    it('should return entitlement_denied when canAccess returns false (assign)', async () => {
      mockCanAccess.mockResolvedValue(false);

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      const failed = expectFailure(result);
      expect(failed.error).toBe('entitlement_denied');
      expect(failed.entitlement?.featureKey).toBe('app_level_roles');
      expect(mockCanAccess).toHaveBeenCalledWith(TENANT_ID, 'app_level_roles');
    });

    it('should return entitlement_denied when canAccess returns false (updateRole)', async () => {
      mockCanAccess.mockResolvedValue(false);

      const svc = buildService();
      const result = await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'admin');

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
    });

    it('should return entitlement_denied when canAccess returns false (revoke)', async () => {
      mockCanAccess.mockResolvedValue(false);

      const svc = buildService();
      const result = await svc.revoke(TENANT_ID, ROLE_ROW_ID);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
    });

    it('should return entitlement_denied when canAccess returns false (bulkAssign)', async () => {
      mockCanAccess.mockResolvedValue(false);

      const svc = buildService();
      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [{ appId: APP_ID, role: 'read' }],
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
    });

    it('should return entitlement_denied when canAccess returns false (revokeAllForMembership)', async () => {
      mockCanAccess.mockResolvedValue(false);

      const svc = buildService();
      const result = await svc.revokeAllForMembership(TENANT_ID, MEMBERSHIP_ID);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
    });

    it('should proceed past the entitlement gate when canAccess returns true (assign)', async () => {
      mockCanAccess.mockResolvedValue(true);

      const row = makeMockRow();
      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: { data: row, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      expect(expectSuccess(result).data).toEqual(row);
    });

    it('should proceed past the entitlement gate when canAccess returns true (updateRole)', async () => {
      mockCanAccess.mockResolvedValue(true);

      const updatedRow = makeMockRow({ role: 'admin' });
      const db = stubDb({
        app_member_role: { data: updatedRow, error: null },
      });
      const svc = buildService(db);

      const result = await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'admin');

      expect(expectSuccess(result).data.role).toBe('admin');
    });

    it('should proceed past the entitlement gate when canAccess returns true (revoke)', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        app_member_role: { data: null, error: null },
      });
      const svc = buildService(db);

      const result = await svc.revoke(TENANT_ID, ROLE_ROW_ID);

      expect(result.success).toBe(true);
    });
  });

  // ========================================================================
  // 2. Owner protection
  // ========================================================================

  describe('owner protection', () => {
    it('should return error when assigning per-app role to an org owner', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'owner' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'Cannot assign per-app roles to org owners');
    });

    it('should return error when bulk assigning per-app roles to an org owner', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'owner' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [{ appId: APP_ID, role: 'read' }],
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'Cannot assign per-app roles to org owners');
    });

    it('should allow assign when membership role is admin (not owner)', async () => {
      mockCanAccess.mockResolvedValue(true);

      const row = makeMockRow();
      const db = stubDb({
        membership: { data: { role: 'admin' }, error: null },
        app_member_role: { data: row, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      expect(result.success).toBe(true);
    });

    it('should allow assign when membership role is member', async () => {
      mockCanAccess.mockResolvedValue(true);

      const row = makeMockRow({ role: 'read' });
      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: { data: row, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'read',
      });

      expect(result.success).toBe(true);
    });

    it('should allow assign when membership query returns null data', async () => {
      mockCanAccess.mockResolvedValue(true);

      const row = makeMockRow();
      const db = stubDb({
        membership: { data: null, error: null },
        app_member_role: { data: row, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      // data?.role === 'owner' is false when data is null, so assign proceeds
      expect(result.success).toBe(true);
    });
  });

  // ========================================================================
  // 3. Assign flow
  // ========================================================================

  describe('assign()', () => {
    it('should insert with the correct data on happy path', async () => {
      mockCanAccess.mockResolvedValue(true);

      const expectedRow = makeMockRow({ role: 'admin' });
      const appMemberChain = createChain({ data: expectedRow, error: null });

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: () => appMemberChain,
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'admin',
      });

      expect(expectSuccess(result).data).toEqual(expectedRow);
      expect(appMemberChain.insert).toHaveBeenCalledWith({
        membership_id: MEMBERSHIP_ID,
        app_id: APP_ID,
        tenant_id: TENANT_ID,
        role: 'admin',
      });
    });

    it('should return duplicate error when insert returns code 23505', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: { data: null, error: { code: '23505', message: 'unique violation' } },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'Member already has a role on this app');
    });

    it('should return generic DB error when insert fails with non-duplicate error', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: { data: null, error: { code: '42000', message: 'some DB error' } },
      });
      const svc = buildService(db);

      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'write',
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'some DB error');
    });
  });

  // ========================================================================
  // 4. Update role flow
  // ========================================================================

  describe('updateRole()', () => {
    it('should update the role on happy path', async () => {
      mockCanAccess.mockResolvedValue(true);

      const updatedRow = makeMockRow({ role: 'admin' });
      const updateChain = createChain({ data: updatedRow, error: null });

      const db = stubDb({
        app_member_role: () => updateChain,
      });
      const svc = buildService(db);

      const result = await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'admin');

      expect(expectSuccess(result).data.role).toBe('admin');
      expect(updateChain.update).toHaveBeenCalledWith({ role: 'admin', custom_role_id: null });
    });

    it('should return error when update fails with DB error', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        app_member_role: { data: null, error: { message: 'row not found' } },
      });
      const svc = buildService(db);

      const result = await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'read');

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'row not found');
    });
  });

  // ========================================================================
  // 5. Revoke flow
  // ========================================================================

  describe('revoke()', () => {
    it('should delete the role on happy path', async () => {
      mockCanAccess.mockResolvedValue(true);

      const deleteChain = createChain({ data: null, error: null });

      const db = stubDb({
        app_member_role: () => deleteChain,
      });
      const svc = buildService(db);

      const result = await svc.revoke(TENANT_ID, ROLE_ROW_ID);

      expect(expectSuccess(result).data).toEqual({ success: true });
      expect(deleteChain.delete).toHaveBeenCalledWith();
      expect(deleteChain.eq).toHaveBeenCalledWith('id', ROLE_ROW_ID);
    });

    it('should return error when delete fails with DB error', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        app_member_role: { data: null, error: { message: 'delete failed' } },
      });
      const svc = buildService(db);

      const result = await svc.revoke(TENANT_ID, ROLE_ROW_ID);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'delete failed');
    });
  });

  // ========================================================================
  // 6. revokeAllForMembership
  // ========================================================================

  describe('revokeAllForMembership()', () => {
    it('should delete all roles for a membership on happy path', async () => {
      mockCanAccess.mockResolvedValue(true);

      const deleteChain = createChain({ data: null, error: null });

      const db = stubDb({
        app_member_role: () => deleteChain,
      });
      const svc = buildService(db);

      const result = await svc.revokeAllForMembership(TENANT_ID, MEMBERSHIP_ID);

      expect(expectSuccess(result).data).toEqual({ success: true });
      expect(deleteChain.delete).toHaveBeenCalledWith();
      expect(deleteChain.eq).toHaveBeenCalledWith('membership_id', MEMBERSHIP_ID);
    });

    it('should return error when delete fails', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        app_member_role: { data: null, error: { message: 'cascade error' } },
      });
      const svc = buildService(db);

      const result = await svc.revokeAllForMembership(TENANT_ID, MEMBERSHIP_ID);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'cascade error');
    });
  });

  // ========================================================================
  // 7. Validation errors (Yup)
  // ========================================================================

  describe('validation', () => {
    it('should return validation error when membershipId is not a valid UUID (assign)', async () => {
      const svc = buildService();
      const result = await svc.assign(TENANT_ID, {
        membershipId: 'not-a-uuid',
        appId: APP_ID,
        role: 'write',
      });

      expect(expectFailure(result).error).toMatch(/must be a valid UUID/i);
      // Validation fires before entitlement check
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should return validation error when appId is not a valid UUID (assign)', async () => {
      const svc = buildService();
      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: 'bad-id',
        role: 'write',
      });

      expect(expectFailure(result).error).toMatch(/must be a valid UUID/i);
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should return validation error when role is invalid (assign)', async () => {
      const svc = buildService();
      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'superadmin' as never,
      });

      expect(expectFailure(result).error).toMatch(/must be one of/i);
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should return validation error when role is invalid (updateRole)', async () => {
      const svc = buildService();
      const result = await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'owner' as never);

      expect(expectFailure(result).error).toMatch(/must be one of/i);
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should return validation error when membershipId is not a valid UUID (bulkAssign)', async () => {
      const svc = buildService();
      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: 'invalid',
        assignments: [{ appId: APP_ID, role: 'read' }],
      });

      expect(expectFailure(result).error).toMatch(/must be a valid UUID/i);
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should return validation error when assignments array is empty (bulkAssign)', async () => {
      const svc = buildService();
      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [],
      });

      // Yup min(1) rejects empty arrays
      expect(expectFailure(result).error).toContain('at least 1');
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should return the EXACT UUID message (not the ZodError JSON blob) when appId is invalid (assign)', async () => {
      const svc = buildService();
      const result = await svc.assign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: 'bad-id',
        role: 'write',
      });

      // Exact match — a JSON-blob mutant (the `e instanceof z.ZodError`
      // conditional in zodErrorMessage flipped so it returns `e.message`) would
      // yield the serialized issues array, not this precise string. Kills the
      // zodErrorMessage conditional survivor.
      expect(expectFailure(result).error).toBe('Must be a valid UUID');
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should reject a bulk assignment whose appId is not a valid UUID (each assignment object is validated)', async () => {
      const svc = buildService();
      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [{ appId: 'bad-id', role: 'read' }],
      });

      // If the per-assignment object schema were stripped to `z.object({})`
      // (the ObjectLiteral survivor), a bad appId would pass validation and the
      // flow would proceed past the gate — this exact message would not appear.
      expect(expectFailure(result).error).toBe('Must be a valid UUID');
      expect(mockCanAccess).not.toHaveBeenCalled();
    });

    it('should reject a bulk assignment whose role is invalid (each assignment object is validated)', async () => {
      const svc = buildService();
      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [{ appId: APP_ID, role: 'superadmin' as never }],
      });

      // Second guard on the same ObjectLiteral: an empty object schema would
      // also let an out-of-enum role through.
      expect(expectFailure(result).error).toBe(
        'role must be one of the following values: read, write, admin',
      );
      expect(mockCanAccess).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // 8. Bulk assign
  // ========================================================================

  describe('bulkAssign()', () => {
    it('should create all assignments on happy path and return count', async () => {
      mockCanAccess.mockResolvedValue(true);

      // `bulkAssign` calls from('membership') once (isOwner) and
      // from('app_member_role') N times (one per assignment).
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            return createChain({ data: { role: 'member' }, error: null });
          }
          // app_member_role insert succeeds
          return createChain({ data: null, error: null });
        }),
      } as unknown as SupabaseClient;

      const svc = buildService(db);

      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [
          { appId: APP_ID, role: 'read' },
          { appId: APP_ID_2, role: 'admin' },
        ],
      });

      const { data } = expectSuccess(result);
      expect(data.created).toBe(2);
      expect(data.errors).toEqual([]);
    });

    it('should populate errors array when one insert fails (partial failure)', async () => {
      mockCanAccess.mockResolvedValue(true);

      let appMemberRoleCallIndex = 0;
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            return createChain({ data: { role: 'member' }, error: null });
          }
          // app_member_role: first insert succeeds, second fails
          appMemberRoleCallIndex++;
          if (appMemberRoleCallIndex === 1) {
            return createChain({ data: null, error: null });
          }
          return createChain({ data: null, error: { message: 'unique constraint' } });
        }),
      } as unknown as SupabaseClient;

      const svc = buildService(db);

      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [
          { appId: APP_ID, role: 'write' },
          { appId: APP_ID_2, role: 'read' },
        ],
      });

      const { data } = expectSuccess(result);
      expect(data.created).toBe(1);
      expect(data.errors).toHaveLength(1);
      expect(data.errors[0]!.appId).toBe(APP_ID_2);
      expect(data.errors[0]!.error).toBe('unique constraint');
    });

    it('should call insert with correct data for each assignment', async () => {
      mockCanAccess.mockResolvedValue(true);

      const insertCalls: unknown[] = [];
      const auditInserts: unknown[] = [];
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            return createChain({ data: { role: 'member' }, error: null });
          }
          const chain = createChain({ data: null, error: null });
          // Capture the insert call arguments (role rows and audit rows separately)
          chain.insert = vi.fn().mockImplementation((data: unknown) => {
            (table === 'audit_log' ? auditInserts : insertCalls).push(data);
            return chain;
          });
          return chain;
        }),
      } as unknown as SupabaseClient;

      const svc = buildService(db);

      await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [
          { appId: APP_ID, role: 'read' },
          { appId: APP_ID_2, role: 'admin' },
        ],
      });

      expect(insertCalls).toHaveLength(2);
      expect(insertCalls[0]).toEqual({
        membership_id: MEMBERSHIP_ID,
        app_id: APP_ID,
        tenant_id: TENANT_ID,
        role: 'read',
      });
      expect(insertCalls[1]).toEqual({
        membership_id: MEMBERSHIP_ID,
        app_id: APP_ID_2,
        tenant_id: TENANT_ID,
        role: 'admin',
      });

      // The bulk assignment writes exactly one immutable audit row
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0]).toEqual(
        expect.objectContaining({
          tenant_id: TENANT_ID,
          action_type: 'app_roles_bulk_assigned',
          target_type: 'app_member_role',
          after_state: {
            assignments: [
              { appId: APP_ID, role: 'read' },
              { appId: APP_ID_2, role: 'admin' },
            ],
          },
          details: { membership_id: MEMBERSHIP_ID, created: 2, failed: 0 },
        }),
      );
    });

    it('should return all errors when every insert fails', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            return createChain({ data: { role: 'member' }, error: null });
          }
          return createChain({ data: null, error: { message: 'connection lost' } });
        }),
      } as unknown as SupabaseClient;

      const svc = buildService(db);

      const result = await svc.bulkAssign(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        assignments: [
          { appId: APP_ID, role: 'write' },
          { appId: APP_ID_2, role: 'read' },
        ],
      });

      const { data } = expectSuccess(result);
      expect(data.created).toBe(0);
      expect(data.errors).toHaveLength(2);
    });
  });

  // ========================================================================
  // 9. isAppScoped (reads membership.is_app_scoped flag)
  // ========================================================================

  describe('isAppScoped()', () => {
    it('should return true when membership.is_app_scoped is true', async () => {
      const db = stubDb({
        membership: { data: { is_app_scoped: true }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.isAppScoped(MEMBERSHIP_ID);

      expect(result).toBe(true);
    });

    it('should return false when membership.is_app_scoped is false', async () => {
      const db = stubDb({
        membership: { data: { is_app_scoped: false }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.isAppScoped(MEMBERSHIP_ID);

      expect(result).toBe(false);
    });

    it('should return false when data is null', async () => {
      const db = stubDb({
        membership: { data: null, error: null },
      });
      const svc = buildService(db);

      const result = await svc.isAppScoped(MEMBERSHIP_ID);

      expect(result).toBe(false);
    });

    it('should throw when query returns error', async () => {
      const db = stubDb({
        membership: { data: null, error: { message: 'query failed' } },
      });
      const svc = buildService(db);

      await expect(svc.isAppScoped(MEMBERSHIP_ID)).rejects.toThrow('query failed');
    });
  });

  // ========================================================================
  // 9b. setAppScoped
  // ========================================================================

  describe('setAppScoped()', () => {
    it('should set is_app_scoped to true on happy path', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.setAppScoped(TENANT_ID, MEMBERSHIP_ID, true);

      expect(expectSuccess(result).data).toEqual({ isAppScoped: true });
    });

    it('should set is_app_scoped to false on happy path', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.setAppScoped(TENANT_ID, MEMBERSHIP_ID, false);

      expect(expectSuccess(result).data).toEqual({ isAppScoped: false });
    });

    it('should return entitlement_denied when entitlement is not active', async () => {
      mockCanAccess.mockResolvedValue(false);

      const svc = buildService();

      const result = await svc.setAppScoped(TENANT_ID, MEMBERSHIP_ID, true);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
    });

    it('should return error when target is an owner', async () => {
      mockCanAccess.mockResolvedValue(true);

      const db = stubDb({
        membership: { data: { role: 'owner' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.setAppScoped(TENANT_ID, MEMBERSHIP_ID, true);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'Cannot restrict app access for org owners');
    });

    it('should return error when update fails', async () => {
      mockCanAccess.mockResolvedValue(true);

      // isOwner() is the first call (select → succeeds), update is the second (fails)
      let callCount = 0;
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'membership') {
            callCount++;
            if (callCount === 1) {
              // isOwner() select — succeed with non-owner role
              return createChain({ data: { role: 'member' }, error: null });
            }
            // update — fail
            return createChain({ data: null, error: { message: 'update failed' } });
          }
          return createChain({ data: null, error: null });
        }),
      } as unknown as SupabaseClient;
      const svc = buildService(db);

      const result = await svc.setAppScoped(TENANT_ID, MEMBERSHIP_ID, true);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'update failed');
    });
  });

  // ========================================================================
  // 10. Query methods
  // ========================================================================

  describe('getByMembership()', () => {
    it('should return rows for a membership', async () => {
      const rows = [makeMockRow(), makeMockRow({ id: 'other-id', app_id: APP_ID_2, role: 'read' })];
      const db = stubDb({
        app_member_role: { data: rows, error: null },
      });
      const svc = buildService(db);

      const result = await svc.getByMembership(MEMBERSHIP_ID);

      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no rows exist', async () => {
      const db = stubDb({
        app_member_role: { data: null, error: null },
      });
      const svc = buildService(db);

      const result = await svc.getByMembership(MEMBERSHIP_ID);

      expect(result).toEqual([]);
    });

    it('should throw when query returns error', async () => {
      const db = stubDb({
        app_member_role: { data: null, error: { message: 'permission denied' } },
      });
      const svc = buildService(db);

      await expect(svc.getByMembership(MEMBERSHIP_ID)).rejects.toThrow('permission denied');
    });
  });

  describe('getByApp()', () => {
    it('should return rows for an app', async () => {
      const rows = [makeMockRow()];
      const db = stubDb({
        app_member_role: { data: rows, error: null },
      });
      const svc = buildService(db);

      const result = await svc.getByApp(APP_ID);

      expect(result).toEqual(rows);
    });

    it('should return empty array when data is null', async () => {
      const db = stubDb({
        app_member_role: { data: null, error: null },
      });
      const svc = buildService(db);

      const result = await svc.getByApp(APP_ID);

      expect(result).toEqual([]);
    });

    it('should throw when query returns error', async () => {
      const db = stubDb({
        app_member_role: { data: null, error: { message: 'timeout' } },
      });
      const svc = buildService(db);

      await expect(svc.getByApp(APP_ID)).rejects.toThrow('timeout');
    });
  });

  describe('getAll()', () => {
    it('should return all rows for a tenant', async () => {
      const rows = [
        makeMockRow(),
        makeMockRow({ id: 'row-2', app_id: APP_ID_2, membership_id: 'other-member' }),
      ];
      const db = stubDb({
        app_member_role: { data: rows, error: null },
      });
      const svc = buildService(db);

      const result = await svc.getAll(TENANT_ID);

      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no rows exist', async () => {
      const db = stubDb({
        app_member_role: { data: null, error: null },
      });
      const svc = buildService(db);

      const result = await svc.getAll(TENANT_ID);

      expect(result).toEqual([]);
    });

    it('should throw when query returns error', async () => {
      const db = stubDb({
        app_member_role: { data: null, error: { message: 'table missing' } },
      });
      const svc = buildService(db);

      await expect(svc.getAll(TENANT_ID)).rejects.toThrow('table missing');
    });
  });

  // ========================================================================
  // 12. assignCustomRole() (K: tests 62-65)
  // ========================================================================

  describe('assignCustomRole()', () => {
    it('should insert app_member_role with custom_role_id and null role when assignCustomRole succeeds', async () => {
      mockCanAccess.mockResolvedValue(true);
      const expectedRow = makeMockRow({ role: 'read', custom_role_id: CUSTOM_ROLE_ID });
      const appMemberChain = createChain({ data: expectedRow, error: null });

      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: () => appMemberChain,
      });
      const svc = buildService(db);

      const result = await svc.assignCustomRole(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'read',
        customRoleId: CUSTOM_ROLE_ID,
      });

      const { data } = expectSuccess(result);
      expect(data.role).toBe('read');
      expect(data.custom_role_id).toBe(CUSTOM_ROLE_ID);
      expect(appMemberChain.insert).toHaveBeenCalledWith({
        membership_id: MEMBERSHIP_ID,
        app_id: APP_ID,
        tenant_id: TENANT_ID,
        role: 'read',
        custom_role_id: CUSTOM_ROLE_ID,
      });
    });

    it('should return entitlement_denied when canAccess returns false (assignCustomRole)', async () => {
      mockCanAccess.mockResolvedValue(false);
      const svc = buildService();

      const result = await svc.assignCustomRole(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'read',
        customRoleId: CUSTOM_ROLE_ID,
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
      expect(result).toHaveProperty('entitlement');
    });

    it('should return error when target is an org owner (assignCustomRole)', async () => {
      mockCanAccess.mockResolvedValue(true);
      const db = stubDb({
        membership: { data: { role: 'owner' }, error: null },
      });
      const svc = buildService(db);

      const result = await svc.assignCustomRole(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'read',
        customRoleId: CUSTOM_ROLE_ID,
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'Cannot assign per-app roles to org owners');
    });

    it('should return duplicate error when insert returns code 23505 (assignCustomRole)', async () => {
      mockCanAccess.mockResolvedValue(true);
      const db = stubDb({
        membership: { data: { role: 'member' }, error: null },
        app_member_role: { data: null, error: { code: '23505', message: 'unique violation' } },
      });
      const svc = buildService(db);

      const result = await svc.assignCustomRole(TENANT_ID, {
        membershipId: MEMBERSHIP_ID,
        appId: APP_ID,
        role: 'read',
        customRoleId: CUSTOM_ROLE_ID,
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'Member already has a role on this app');
    });
  });

  // ========================================================================
  // 13. updateCustomRole() (L: tests 66-68)
  // ========================================================================

  describe('updateCustomRole()', () => {
    it('should update custom_role_id as override when updateCustomRole succeeds', async () => {
      mockCanAccess.mockResolvedValue(true);
      const updatedRow = makeMockRow({ role: 'read', custom_role_id: CUSTOM_ROLE_ID });
      const updateChain = createChain({ data: updatedRow, error: null });

      const db = stubDb({
        app_member_role: () => updateChain,
      });
      const svc = buildService(db);

      const result = await svc.updateCustomRole(TENANT_ID, ROLE_ROW_ID, CUSTOM_ROLE_ID);

      const { data } = expectSuccess(result);
      expect(data.role).toBe('read');
      expect(data.custom_role_id).toBe(CUSTOM_ROLE_ID);
      expect(updateChain.update).toHaveBeenCalledWith({ custom_role_id: CUSTOM_ROLE_ID });
    });

    it('should return entitlement_denied when canAccess returns false (updateCustomRole)', async () => {
      mockCanAccess.mockResolvedValue(false);
      const svc = buildService();

      const result = await svc.updateCustomRole(TENANT_ID, ROLE_ROW_ID, CUSTOM_ROLE_ID);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'entitlement_denied');
      expect(result).toHaveProperty('entitlement');
    });

    it('should return DB error when update fails (updateCustomRole)', async () => {
      mockCanAccess.mockResolvedValue(true);
      const db = stubDb({
        app_member_role: { data: null, error: { message: 'row not found' } },
      });
      const svc = buildService(db);

      const result = await svc.updateCustomRole(TENANT_ID, ROLE_ROW_ID, CUSTOM_ROLE_ID);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error', 'row not found');
    });
  });

  // ========================================================================
  // 11. EntitlementService construction
  // ========================================================================

  describe('EntitlementService construction', () => {
    it('should construct EntitlementService with the injected db client', async () => {
      const { EntitlementService: MockedEntitlementService } =
        await import('@/lib/system/entitlement-service');

      mockCanAccess.mockResolvedValue(false);

      const db = stubDb();
      const svc = buildService(db);
      await svc.revoke(TENANT_ID, ROLE_ROW_ID);

      expect(MockedEntitlementService).toHaveBeenCalledWith({ db });
    });
  });
});

// ---------------------------------------------------------------------------
// Audit trail writes — payload-exact pins
// ---------------------------------------------------------------------------

describe('audit trail writes', () => {
  const ACTOR_ID = '66666666-6666-4666-a666-666666666666';

  /** Captures every insert into audit_log through the shared stub db. */
  function auditCapture() {
    const rows: unknown[] = [];
    const handler = () => {
      const chain = createChain({ data: null, error: null });
      chain.insert = vi.fn().mockImplementation((payload: unknown) => {
        rows.push(payload);
        return chain;
      });
      return chain;
    };
    return { rows, handler };
  }

  function buildAuditedService(
    tableHandlers: Record<string, ChainResult | (() => ReturnType<typeof createChain>)>,
  ) {
    const audit = auditCapture();
    const db = stubDb({ ...tableHandlers, audit_log: audit.handler });
    const svc = new AppMemberRoleService({ db, actorId: ACTOR_ID });
    return { svc, audit };
  }

  beforeEach(() => {
    mockCanAccess.mockResolvedValue(true);
  });

  it('assign writes an exact app_role_assigned row', async () => {
    const { svc, audit } = buildAuditedService({
      membership: { data: { role: 'member' }, error: null },
      app_member_role: { data: makeMockRow({ role: 'read' }), error: null },
    });

    await svc.assign(TENANT_ID, { membershipId: MEMBERSHIP_ID, appId: APP_ID, role: 'read' });

    expect(audit.rows).toEqual([
      {
        tenant_id: TENANT_ID,
        actor_id: ACTOR_ID,
        actor_type: 'human',
        actor_label: null,
        action_type: 'app_role_assigned',
        target_type: 'app_member_role',
        target_id: ROLE_ROW_ID,
        target_identifier: null,
        before_state: null,
        after_state: { role: 'read' },
        details: { app_id: APP_ID, membership_id: MEMBERSHIP_ID },
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('assignCustomRole writes the custom role id in after_state', async () => {
    const { svc, audit } = buildAuditedService({
      membership: { data: { role: 'member' }, error: null },
      app_member_role: { data: makeMockRow({ role: 'read', custom_role_id: CUSTOM_ROLE_ID }), error: null },
    });

    await svc.assignCustomRole(TENANT_ID, {
      membershipId: MEMBERSHIP_ID,
      appId: APP_ID,
      role: 'read',
      customRoleId: CUSTOM_ROLE_ID,
    });

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'app_role_assigned',
        target_id: ROLE_ROW_ID,
        after_state: { role: 'read', custom_role_id: CUSTOM_ROLE_ID },
        details: { app_id: APP_ID, membership_id: MEMBERSHIP_ID },
      }),
    ]);
  });

  it('updateRole writes before/after states from the pre-image', async () => {
    const before = { role: 'write', custom_role_id: CUSTOM_ROLE_ID, app_id: APP_ID, membership_id: MEMBERSHIP_ID };
    let call = 0;
    const { svc, audit } = buildAuditedService({
      app_member_role: () => {
        call += 1;
        // 1st call: getRowForAudit pre-image; 2nd call: the update itself
        return createChain(
          call === 1
            ? { data: before, error: null }
            : { data: makeMockRow({ role: 'admin', custom_role_id: null }), error: null },
        );
      },
    });

    await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'admin');

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'app_role_updated',
        target_type: 'app_member_role',
        target_id: ROLE_ROW_ID,
        before_state: before,
        after_state: { role: 'admin', custom_role_id: null },
        details: { app_id: APP_ID, membership_id: MEMBERSHIP_ID },
      }),
    ]);
  });

  it('updateRole with no pre-image writes null before_state and details', async () => {
    let call = 0;
    const { svc, audit } = buildAuditedService({
      app_member_role: () => {
        call += 1;
        return createChain(
          call === 1
            ? { data: null, error: null }
            : { data: makeMockRow({ role: 'admin' }), error: null },
        );
      },
    });

    await svc.updateRole(TENANT_ID, ROLE_ROW_ID, 'admin');

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'app_role_updated',
        before_state: null,
        after_state: { role: 'admin', custom_role_id: null },
        details: null,
      }),
    ]);
  });

  it('updateCustomRole keeps the built-in role and swaps the custom role id', async () => {
    const before = { role: 'read', custom_role_id: null, app_id: APP_ID, membership_id: MEMBERSHIP_ID };
    let call = 0;
    const { svc, audit } = buildAuditedService({
      app_member_role: () => {
        call += 1;
        return createChain(
          call === 1
            ? { data: before, error: null }
            : { data: makeMockRow({ custom_role_id: CUSTOM_ROLE_ID }), error: null },
        );
      },
    });

    await svc.updateCustomRole(TENANT_ID, ROLE_ROW_ID, CUSTOM_ROLE_ID);

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'app_role_updated',
        target_id: ROLE_ROW_ID,
        before_state: before,
        after_state: { role: 'read', custom_role_id: CUSTOM_ROLE_ID },
        details: { app_id: APP_ID, membership_id: MEMBERSHIP_ID },
      }),
    ]);
  });

  it('revoke writes the deleted row as before_state', async () => {
    const { svc, audit } = buildAuditedService({
      app_member_role: {
        data: [{ role: 'write', custom_role_id: null, app_id: APP_ID, membership_id: MEMBERSHIP_ID }],
        error: null,
      },
    });

    await svc.revoke(TENANT_ID, ROLE_ROW_ID);

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'app_role_revoked',
        target_type: 'app_member_role',
        target_id: ROLE_ROW_ID,
        before_state: { role: 'write', custom_role_id: null },
        details: { app_id: APP_ID, membership_id: MEMBERSHIP_ID },
      }),
    ]);
  });

  it('revoke writes no audit row when nothing was deleted', async () => {
    const { svc, audit } = buildAuditedService({
      app_member_role: { data: [], error: null },
    });

    await svc.revoke(TENANT_ID, ROLE_ROW_ID);

    expect(audit.rows).toEqual([]);
  });

  it('revokeAllForMembership writes one row with the revoked set', async () => {
    const { svc, audit } = buildAuditedService({
      app_member_role: {
        data: [
          { app_id: APP_ID, role: 'read' },
          { app_id: APP_ID_2, role: 'admin' },
        ],
        error: null,
      },
    });

    await svc.revokeAllForMembership(TENANT_ID, MEMBERSHIP_ID);

    expect(audit.rows).toEqual([
      expect.objectContaining({
        action_type: 'app_role_revoked',
        target_id: null,
        before_state: {
          revoked: [
            { app_id: APP_ID, role: 'read' },
            { app_id: APP_ID_2, role: 'admin' },
          ],
        },
        details: { membership_id: MEMBERSHIP_ID, revoked_count: 2 },
      }),
    ]);
  });

  it('revokeAllForMembership writes no audit row when nothing was deleted', async () => {
    const { svc, audit } = buildAuditedService({
      app_member_role: { data: [], error: null },
    });

    await svc.revokeAllForMembership(TENANT_ID, MEMBERSHIP_ID);

    expect(audit.rows).toEqual([]);
  });

  it('setAppScoped writes an app_scope_changed row targeting the membership', async () => {
    let call = 0;
    const { svc, audit } = buildAuditedService({
      membership: () => {
        call += 1;
        // 1st call: isOwner check; 2nd call: the is_app_scoped update
        return createChain(
          call === 1
            ? { data: { role: 'member' }, error: null }
            : { data: { is_app_scoped: true }, error: null },
        );
      },
    });

    await svc.setAppScoped(TENANT_ID, MEMBERSHIP_ID, true);

    expect(audit.rows).toEqual([
      {
        tenant_id: TENANT_ID,
        actor_id: ACTOR_ID,
        actor_type: 'human',
        actor_label: null,
        action_type: 'app_scope_changed',
        target_type: 'membership',
        target_id: MEMBERSHIP_ID,
        target_identifier: null,
        before_state: null,
        after_state: { is_app_scoped: true },
        details: null,
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('records a null actor when the service is constructed without one', async () => {
    const audit = auditCapture();
    const db = stubDb({
      membership: { data: { role: 'member' }, error: null },
      app_member_role: { data: makeMockRow({ role: 'read' }), error: null },
      audit_log: audit.handler,
    });
    const svc = new AppMemberRoleService({ db });

    await svc.assign(TENANT_ID, { membershipId: MEMBERSHIP_ID, appId: APP_ID, role: 'read' });

    expect(audit.rows).toEqual([
      expect.objectContaining({ actor_id: null, actor_type: 'human' }),
    ]);
  });
});
