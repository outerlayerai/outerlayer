import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jwt', () => ({
  mintGatewayJwt: vi.fn().mockResolvedValue('mocked-jwt-token'),
}));

import * as scopedClientModule from '../scoped-client';
import { mintGatewayJwt } from '../jwt';

const mockEnv = {
  SUPABASE_API_BASE_URL: 'http://localhost:54321',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  SUPABASE_JWT_SECRET: 'test-jwt-secret-at-least-32-chars!!',
  SUPABASE_SECRET_KEY: 'test-secret-key-should-not-be-used',
  UNKEY_ROOT_KEY: '',
  CLICKHOUSE_HOST: '',
  CLICKHOUSE_USER: '',
  CLICKHOUSE_PASSWORD: '',
  BETTERSTACK_SOURCE_TOKEN: '',
  SENTRY_DSN: '',
} as any;

describe('createTenantScopedClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(scopedClientModule.scopedSupabaseClientFactory, 'create').mockReturnValue({ from: vi.fn() } as any);
  });

  it('should mint a JWT with the correct arguments', async () => {
    await scopedClientModule.createTenantScopedClient(mockEnv, 'tenant-123', 'user-456', ['trace.read', 'score.write']);

    expect(mintGatewayJwt).toHaveBeenCalledOnce();
    expect(mintGatewayJwt).toHaveBeenCalledWith(
      'test-jwt-secret-at-least-32-chars!!',
      'tenant-123',
      'user-456',
      ['trace.read', 'score.write'],
    );
  });

  it('should create a Supabase client with the publishable key, not the secret key', async () => {
    await scopedClientModule.createTenantScopedClient(mockEnv, 'tenant-123', 'user-456', ['trace.read']);

    expect(scopedClientModule.scopedSupabaseClientFactory.create).toHaveBeenCalledOnce();
    const [envArg, jwt] = vi.mocked(scopedClientModule.scopedSupabaseClientFactory.create).mock.calls[0]!;
    expect(envArg.SUPABASE_API_BASE_URL).toBe('http://localhost:54321');
    expect(envArg.SUPABASE_PUBLISHABLE_KEY).toBe('test-publishable-key');
    expect(envArg.SUPABASE_PUBLISHABLE_KEY).not.toBe('test-secret-key-should-not-be-used');
    expect(jwt).toBe('mocked-jwt-token');
  });

  it('should pass the minted JWT as a Bearer authorization header', async () => {
    await scopedClientModule.createTenantScopedClient(mockEnv, 'tenant-123', 'user-456', ['trace.read']);
    expect(scopedClientModule.scopedSupabaseClientFactory.create).toHaveBeenCalledWith(
      mockEnv,
      'mocked-jwt-token',
    );
  });

  it('should return the client created by createClient', async () => {
    const fakeClient = { from: vi.fn(), rpc: vi.fn() };
    vi.mocked(scopedClientModule.scopedSupabaseClientFactory.create).mockReturnValue(fakeClient as any);

    const result = await scopedClientModule.createTenantScopedClient(mockEnv, 'tenant-123', 'user-456', []);

    expect(result).toBe(fakeClient);
  });

  it('should pass an empty permissions array through to mintGatewayJwt', async () => {
    await scopedClientModule.createTenantScopedClient(mockEnv, 'tenant-123', 'user-456', []);

    expect(mintGatewayJwt).toHaveBeenCalledWith(
      'test-jwt-secret-at-least-32-chars!!',
      'tenant-123',
      'user-456',
      [],
    );
  });
});
