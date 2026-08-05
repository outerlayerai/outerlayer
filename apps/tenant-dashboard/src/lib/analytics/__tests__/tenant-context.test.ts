/**
 * TenantContext and verifyAppAccess() Tests
 *
 * Test names follow "should [outcome] when [condition]".
 */

vi.mock('server-only', () => ({}));

import { http, HttpResponse } from 'msw';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- test-only stand-in for the RLS-scoped `ctx.db` a caller passes in production: a plain anon-key client against MSW, never the service-role admin client the rail confines to lib/system.
import { createClient } from '@supabase/supabase-js';
import { ForbiddenError } from '@repo/observability-service';
import { server } from '@/test-helpers/msw-server';
import { seedSupabaseMswState } from '@/test-helpers/msw-handlers';
import type { Database } from '@/types/db';
import { verifyAppAccess, type TenantContext } from '../tenant-context';

// A real client over MSW — the same shape `verifyAppAccess` receives as
// `ctx.db` from the caller's request-scoped service context.
const db = createClient<Database>('http://localhost:54321', 'test-anon-key');

describe('TenantContext', () => {
  describe('verifyAppAccess', () => {
    const validUserId = 'user-123';
    const validTenantId = 'tenant-456';
    const validAppId = 'app-789';

    describe('successful verification', () => {
      it('should return TenantContext when app belongs to tenant', async () => {
        seedSupabaseMswState({
          apps: [{ id: validAppId, tenant_id: validTenantId }],
        });

        const context = await verifyAppAccess(db, validUserId, validTenantId, validAppId);

        expect(context).toEqual({
          userId: validUserId,
          tenantId: validTenantId,
          appId: validAppId,
          dataRetentionDays: -1,
        });
      });

      it('should return frozen (immutable) context object', async () => {
        seedSupabaseMswState({
          apps: [{ id: validAppId, tenant_id: validTenantId }],
        });

        const context = await verifyAppAccess(db, validUserId, validTenantId, validAppId);

        expect(Object.isFrozen(context)).toBe(true);
      });

      it('should query database with correct tenant_id filter', async () => {
        let capturedRequestUrl: string | null = null;

        server.use(
          http.get('http://localhost:54321/rest/v1/app', ({ request }) => {
            capturedRequestUrl = request.url;
            return HttpResponse.json({ id: validAppId, tenant_id: validTenantId });
          }),
        );

        await verifyAppAccess(db, validUserId, validTenantId, validAppId);

        expect(capturedRequestUrl).not.toBeNull();
        if (!capturedRequestUrl) {
          throw new Error('Expected app lookup request to be captured');
        }
        const url = new URL(capturedRequestUrl);
        expect(url.searchParams.get('id')).toBe(`eq.${validAppId}`);
        expect(url.searchParams.get('tenant_id')).toBe(`eq.${validTenantId}`);
      });
    });

    describe('access denied scenarios', () => {
      it('should throw ForbiddenError when app does not exist', async () => {
        await expect(verifyAppAccess(db, validUserId, validTenantId, 'nonexistent-app')).rejects.toThrow(
          ForbiddenError,
        );
      });

      it('should throw ForbiddenError when app belongs to different tenant', async () => {
        seedSupabaseMswState({
          apps: [{ id: 'other-tenant-app', tenant_id: 'tenant-999' }],
        });

        await expect(
          verifyAppAccess(db, validUserId, validTenantId, 'other-tenant-app'),
        ).rejects.toThrow(ForbiddenError);
      });

      it('should throw ForbiddenError with specific message', async () => {
        await expect(verifyAppAccess(db, validUserId, validTenantId, validAppId)).rejects.toThrow(
          'Access denied to this application',
        );
      });

      it('should throw ForbiddenError when database returns error', async () => {
        server.use(
          http.get('http://localhost:54321/rest/v1/app', () =>
            HttpResponse.json({ message: 'Database error' }, { status: 500 }),
          ),
        );

        await expect(verifyAppAccess(db, validUserId, validTenantId, validAppId)).rejects.toThrow(
          ForbiddenError,
        );
      });
    });

    describe('input validation', () => {
      it('should throw when userId is empty', async () => {
        await expect(verifyAppAccess(db, '', validTenantId, validAppId)).rejects.toThrow(
          'userId is required',
        );
      });

      it('should throw when tenantId is empty', async () => {
        await expect(verifyAppAccess(db, validUserId, '', validAppId)).rejects.toThrow(
          'tenantId is required',
        );
      });

      it('should throw when appId is empty', async () => {
        await expect(verifyAppAccess(db, validUserId, validTenantId, '')).rejects.toThrow(
          'appId is required',
        );
      });
    });
  });
});

describe('TenantContext usage patterns', () => {
  it('should allow passing TenantContext to functions requiring it', async () => {
    seedSupabaseMswState({
      apps: [{ id: 'app-123', tenant_id: 'tenant-1' }],
    });

    function requiresContext(ctx: TenantContext): string {
      return `tenant:${ctx.tenantId}, app:${ctx.appId}`;
    }

    const context = await verifyAppAccess(db, 'user-1', 'tenant-1', 'app-123');
    const result = requiresContext(context);

    expect(result).toBe('tenant:tenant-1, app:app-123');
  });
});
