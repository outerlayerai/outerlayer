/**
 * Unit Tests for TempAccessService email integration.
 *
 * Verifies that granting temporary access sends the correct
 * TempAccessNotification email via the shared EmailService.
 */

import { TempAccessService } from '../temp-access-service';
import type { EmailService } from '../../../../lib/external-services';
import type { IAuditLogService } from '../types';
import { EmailType } from '../../../../utils/email';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a chainable Supabase mock that handles both .single() and direct await patterns.
 */
function createChain(response: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'is', 'gt', 'order', 'delete', 'update'];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(response);
  // Make chain thenable for queries that await without .single() (e.g., list queries)
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(response).then(resolve, reject);
  return chain;
}

/**
 * Builds a mock Supabase client that returns the right responses
 * for the full grant() + notifyOwners() flow in TempAccessService.
 */
function createGrantFlowDbMock(config: {
  tenant: { tenant_id: string; organization_name: string };
  adminProfile: { email: string };
  owners: Array<{ user_id: string; profile: { email: string; name: string | null } }>;
}) {
  const tableCallCounts: Record<string, number> = {};

  const fromMock = vi.fn().mockImplementation((table: string) => {
    tableCallCounts[table] = (tableCallCounts[table] || 0) + 1;
    const callNum = tableCallCounts[table];

    switch (table) {
      case 'tenant':
        if (callNum === 1) {
          // grant() Step 1: verify tenant exists
          return createChain({ data: config.tenant, error: null });
        }
        // notifyOwners() Step 6: get org name
        return createChain({
          data: { organization_name: config.tenant.organization_name },
          error: null,
        });

      case 'temp_access_grant':
        // grant() Step 2: check existing grant (none found)
        return createChain({ data: null, error: null });

      case 'membership':
        if (callNum === 1) {
          // grant() Step 3: check existing membership (none found)
          return createChain({ data: null, error: null });
        }
        // notifyOwners() Step 7: get owners (list query, no .single())
        return createChain({ data: config.owners, error: null });

      case 'profile':
        // notifyOwners() Step 5: get admin profile
        return createChain({ data: config.adminProfile, error: null });

      default:
        return createChain({ data: null, error: null });
    }
  });

  const rpcMock = vi.fn().mockResolvedValue({ data: 'grant-id-123', error: null });

  return { from: fromMock, rpc: rpcMock };
}

// ============================================================================
// Tests
// ============================================================================

describe('TempAccessService', () => {
  describe('grant', () => {
    it('sends TempAccessNotification email to org owners on successful grant', async () => {
      const mockEmailService: EmailService = {
        sendEmail: vi.fn().mockResolvedValue({ error: null }),
        addToBroadcastAudience: vi.fn(),
      };

      const mockAuditLog: IAuditLogService = {
        create: vi.fn().mockResolvedValue(undefined),
      };

      const db = createGrantFlowDbMock({
        tenant: { tenant_id: 'tenant-1', organization_name: 'Acme Corp' },
        adminProfile: { email: 'admin@platform.com' },
        owners: [
          { user_id: 'owner-1', profile: { email: 'owner@acme.com', name: 'Alice Owner' } },
        ],
      });

      const service = new TempAccessService({
        db: db as any,
        emailService: mockEmailService,
        auditLog: mockAuditLog,
      });

      const result = await service.grant(
        { tenantId: 'tenant-1', reason: 'Support ticket #456', customerPermissionConfirmed: true },
        'admin-user-id'
      );

      expect(result.error).toBeUndefined();
      expect(result.data).toEqual({ grantId: 'grant-id-123', expiresAt: expect.any(String) });

      expect(mockEmailService.sendEmail).toHaveBeenCalledWith({
        to: 'owner@acme.com',
        subject: 'Platform Admin Access Granted to Acme Corp',
        emailType: EmailType.TempAccessNotification,
        templateParams: {
          appUrl: expect.any(String),
          organizationName: 'Acme Corp',
          adminEmail: 'admin@platform.com',
          expiresAt: expect.any(String),
        },
      });
    });

    it('skips email when emailService is not provided', async () => {
      const mockAuditLog: IAuditLogService = {
        create: vi.fn().mockResolvedValue(undefined),
      };

      const db = createGrantFlowDbMock({
        tenant: { tenant_id: 'tenant-1', organization_name: 'Acme Corp' },
        adminProfile: { email: 'admin@platform.com' },
        owners: [],
      });

      const service = new TempAccessService({
        db: db as any,
        // emailService intentionally omitted
        auditLog: mockAuditLog,
      });

      const result = await service.grant(
        { tenantId: 'tenant-1', reason: 'Support', customerPermissionConfirmed: true },
        'admin-user-id'
      );

      // Grant succeeds even without email service
      expect(result.error).toBeUndefined();
      expect(result.data).toEqual({ grantId: 'grant-id-123', expiresAt: expect.any(String) });
    });

    it('continues grant successfully even if email send fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const mockEmailService: EmailService = {
        sendEmail: vi.fn().mockResolvedValue({ error: new Error('Resend unavailable') }),
        addToBroadcastAudience: vi.fn(),
      };

      const mockAuditLog: IAuditLogService = {
        create: vi.fn().mockResolvedValue(undefined),
      };

      const db = createGrantFlowDbMock({
        tenant: { tenant_id: 'tenant-1', organization_name: 'Acme Corp' },
        adminProfile: { email: 'admin@platform.com' },
        owners: [
          { user_id: 'owner-1', profile: { email: 'owner@acme.com', name: 'Alice' } },
        ],
      });

      const service = new TempAccessService({
        db: db as any,
        emailService: mockEmailService,
        auditLog: mockAuditLog,
      });

      const result = await service.grant(
        { tenantId: 'tenant-1', reason: 'Support', customerPermissionConfirmed: true },
        'admin-user-id'
      );

      // Grant still succeeds — email failure is non-blocking
      expect(result.error).toBeUndefined();
      expect(result.data).toEqual({ grantId: 'grant-id-123', expiresAt: expect.any(String) });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send temp access notification'),
        expect.anything()
      );

      consoleSpy.mockRestore();
    });
  });
});
