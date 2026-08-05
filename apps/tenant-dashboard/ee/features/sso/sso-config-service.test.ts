/**
 * Unit tests for SSOConfigService.
 *
 * Tests cover all public methods with mocked Supabase clients and global fetch.
 * GoTrue REST API calls (create/update/delete SAML provider) are tested via
 * fetch mocks, while Supabase query builder calls use chainable mock objects.
 *
 * One behavior per test, `should [outcome] when [condition]` naming.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SSOConfigService } from './sso-config-service';
import type { SSOConfig, SaveSSOConfigInput } from '@/types/sso';
import { fetchSsoMetadataSafely } from '@/utils/safe-metadata-fetch';

// testConnection now fetches metadata through the SSRF-safe helper (which uses
// node:https + DNS vetting), not global fetch. Mock that seam. The GoTrue
// admin-API calls in saveConfig/etc. still use global fetch and are unaffected.
vi.mock('@/utils/safe-metadata-fetch', () => ({
  fetchSsoMetadataSafely: vi.fn(),
}));
const mockFetchMetadata = vi.mocked(fetchSsoMetadataSafely);

// GoTrue admin config reads the Supabase URL + secret key from validated
// config, not raw process.env. Both are true (non-HTTP) seams, so mock them
// through mutable holders the "missing config" cases flip to undefined.
const configHolder = vi.hoisted(() => ({
  supabaseUrl: 'http://localhost:54321' as string | undefined,
  secretKey: 'test-service-role-key' as string | undefined,
}));
vi.mock('@/config-global', () => ({
  SUPABASE_API: {
    get url() {
      return configHolder.supabaseUrl;
    },
    get key() {
      return 'test-anon-key';
    },
  },
}));
vi.mock('@/config-global.server', () => ({
  get SUPABASE_SECRET_KEY() {
    return configHolder.secretKey;
  },
}));

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = 'tenant-test-001';
const TEST_PROVIDER_ID = 'provider-abc-123';
const TEST_CONFIG_ID = 'sso-config-uuid-1';

function makeSSOConfig(overrides: Partial<SSOConfig> = {}): SSOConfig {
  return {
    id: TEST_CONFIG_ID,
    tenant_id: TEST_TENANT_ID,
    supabase_provider_id: TEST_PROVIDER_ID,
    metadata_url: 'https://idp.example.com/saml/metadata',
    entity_id: 'https://idp.example.com',
    allowed_domains: ['example.com'],
    enforcement_enabled: false,
    is_active: true,
    last_validated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    created_by: 'user-1',
    updated_at: '2026-01-01T00:00:00Z',
    updated_by: 'user-1',
    ...overrides,
  };
}

function makeSaveInput(overrides: Partial<SaveSSOConfigInput> = {}): SaveSSOConfigInput {
  return {
    metadataUrl: 'https://idp.example.com/saml/metadata',
    allowedDomains: ['example.com'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Chainable Supabase mock factory
// ---------------------------------------------------------------------------

type MockFn = ReturnType<typeof vi.fn>;

interface MockChain {
  select: MockFn;
  insert: MockFn;
  update: MockFn;
  delete: MockFn;
  upsert: MockFn;
  eq: MockFn;
  in: MockFn;
  contains: MockFn;
  maybeSingle: MockFn;
  single: MockFn;
}

interface MockSupabase {
  from: MockFn;
  auth: { admin: Record<string, unknown> };
  _chain: MockChain;
}

function createMockChain(): MockChain {
  const chain: MockChain = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    contains: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  // Wire chainable methods to return the chain object
  chain.select.mockReturnValue(chain);
  chain.insert.mockReturnValue(chain);
  chain.update.mockReturnValue(chain);
  chain.delete.mockReturnValue(chain);
  chain.upsert.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  chain.contains.mockReturnValue(chain);

  return chain;
}

function createMockSupabase(): MockSupabase {
  const chain = createMockChain();

  return {
    from: vi.fn().mockReturnValue(chain),
    auth: { admin: {} },
    _chain: chain,
  };
}

function buildService(overrides: { db?: MockSupabase; adminDb?: MockSupabase } = {}) {
  const db = overrides.db ?? createMockSupabase();
  const adminDb = overrides.adminDb ?? createMockSupabase();

  return {
    service: new SSOConfigService({
      db: db as unknown as SupabaseClient,
      adminDb: adminDb as unknown as SupabaseClient,
    }),
    db,
    adminDb,
  };
}

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  configHolder.supabaseUrl = 'http://localhost:54321';
  configHolder.secretKey = 'test-service-role-key';
});

// ---------------------------------------------------------------------------
// getConfig
// ---------------------------------------------------------------------------

describe('SSOConfigService.getConfig', () => {
  it('should return config when found', async () => {
    const config = makeSSOConfig();
    const { service, db } = buildService();
    db._chain.maybeSingle.mockResolvedValue({ data: config, error: null });

    const result = await service.getConfig(TEST_TENANT_ID);

    expect(result).toEqual(config);
    expect(db.from).toHaveBeenCalledWith('sso_config');
    expect(db._chain.select).toHaveBeenCalledWith('*');
    expect(db._chain.eq).toHaveBeenCalledWith('tenant_id', TEST_TENANT_ID);
  });

  it('should return null when not found', async () => {
    const { service, db } = buildService();
    db._chain.maybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await service.getConfig(TEST_TENANT_ID);

    expect(result).toBeNull();
  });

  it('should throw when database returns an error', async () => {
    const { service, db } = buildService();
    db._chain.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });

    await expect(service.getConfig(TEST_TENANT_ID)).rejects.toThrow(
      'Failed to fetch SSO config: connection refused',
    );
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe('SSOConfigService.saveConfig', () => {
  // Helper to mock the GoTrue create provider fetch call
  function mockCreateProviderFetch(providerId: string) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: providerId, saml: { id: providerId } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  // Helper to mock the GoTrue update provider fetch call
  function mockUpdateProviderFetch() {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: TEST_PROVIDER_ID }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('should create new SAML provider when no config exists', async () => {
    const savedConfig = makeSSOConfig();
    const input = makeSaveInput();
    const { service, adminDb } = buildService();

    // getConfigViaAdmin returns null (no existing config)
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    // insert().select().single() returns the saved config
    adminDb._chain.single.mockResolvedValueOnce({ data: savedConfig, error: null });
    // logAuditEvent insert succeeds
    adminDb._chain.single.mockResolvedValueOnce({ data: null, error: null });

    const newProviderId = 'new-provider-id';
    mockCreateProviderFetch(newProviderId);

    const result = await service.saveConfig(TEST_TENANT_ID, input);

    expect(result).toEqual(savedConfig);

    // Verify fetch was called with POST to create provider
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:54321/auth/v1/admin/sso/providers',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"type":"saml"'),
      }),
    );
    // Verify the body includes all required fields
    const callBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body,
    );
    expect(callBody.type).toBe('saml');
    expect(callBody.metadata_url).toBe(input.metadataUrl);
    expect(callBody.domains).toEqual(input.allowedDomains);
    expect(callBody.attribute_mapping.keys.first_name.names).toContain(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    );
    expect(callBody.attribute_mapping.keys.last_name.names).toContain(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    );
    expect(callBody.attribute_mapping.keys.full_name.names).toContain(
      'http://schemas.microsoft.com/identity/claims/displayname',
    );
  });

  it('should update existing SAML provider when config exists', async () => {
    const existingConfig = makeSSOConfig();
    const savedConfig = makeSSOConfig({ updated_at: '2026-02-01T00:00:00Z' });
    const input = makeSaveInput({ metadataUrl: 'https://idp.example.com/saml/metadata-v2' });
    const { service, adminDb } = buildService();

    // getConfigViaAdmin returns existing config
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: existingConfig, error: null });
    // update().eq().select().single() returns the saved config
    adminDb._chain.single.mockResolvedValueOnce({ data: savedConfig, error: null });
    // logAuditEvent insert succeeds
    adminDb._chain.single.mockResolvedValueOnce({ data: null, error: null });

    mockUpdateProviderFetch();

    const result = await service.saveConfig(TEST_TENANT_ID, input);

    expect(result).toEqual(savedConfig);

    // Verify fetch was called with PUT to update provider
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `http://localhost:54321/auth/v1/admin/sso/providers/${TEST_PROVIDER_ID}`,
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"metadata_url"'),
      }),
    );
    // Verify the body includes all required fields
    const updateBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body,
    );
    expect(updateBody.metadata_url).toBe(input.metadataUrl);
    expect(updateBody.domains).toEqual(input.allowedDomains);
    expect(updateBody.attribute_mapping.keys.first_name.names).toContain(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    );
    expect(updateBody.attribute_mapping.keys.last_name.names).toContain(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    );
  });

  it('should return the saved config after insert', async () => {
    const savedConfig = makeSSOConfig({ id: 'new-id' });
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    adminDb._chain.single.mockResolvedValueOnce({ data: savedConfig, error: null });

    mockCreateProviderFetch('new-provider');

    const result = await service.saveConfig(TEST_TENANT_ID, makeSaveInput());

    expect(result.id).toBe('new-id');
  });

  it('should throw when insert fails', async () => {
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    adminDb._chain.single.mockResolvedValueOnce({
      data: null,
      error: { message: 'duplicate key' },
    });

    mockCreateProviderFetch('new-provider');

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Failed to insert SSO config: duplicate key',
    );
  });

  it('should throw when insert returns no data and no error', async () => {
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    adminDb._chain.single.mockResolvedValueOnce({ data: null, error: null });

    mockCreateProviderFetch('new-provider');

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Failed to insert SSO config: No data returned',
    );
  });

  it('should throw when update fails', async () => {
    const existingConfig = makeSSOConfig();
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: existingConfig, error: null });
    adminDb._chain.single.mockResolvedValueOnce({
      data: null,
      error: { message: 'update failed' },
    });

    mockUpdateProviderFetch();

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Failed to update SSO config: update failed',
    );
  });

  it('should throw when GoTrue create provider returns non-OK', async () => {
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Provider creation failed', { status: 422 }),
    );

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Failed to create SAML provider (HTTP 422): Provider creation failed',
    );
  });

  it('should throw when GoTrue update provider returns non-OK', async () => {
    const existingConfig = makeSSOConfig();
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: existingConfig, error: null });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not found', { status: 404 }),
    );

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Failed to update SAML provider (HTTP 404): Not found',
    );
  });

  it('should log audit event after successful save', async () => {
    const savedConfig = makeSSOConfig();
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    adminDb._chain.single.mockResolvedValueOnce({ data: savedConfig, error: null });

    mockCreateProviderFetch('new-provider');

    await service.saveConfig(TEST_TENANT_ID, makeSaveInput());

    // Verify audit log was written
    const fromCalls = adminDb.from.mock.calls.map((c: string[]) => c[0]);
    expect(fromCalls).toContain('sso_audit_log');
  });
});

// ---------------------------------------------------------------------------
// deleteConfig
// ---------------------------------------------------------------------------

describe('SSOConfigService.deleteConfig', () => {
  it('should delete SAML provider and config when config exists', async () => {
    const existingConfig = makeSSOConfig();
    const { service, adminDb } = buildService();

    // getConfigViaAdmin returns existing config
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: existingConfig, error: null });

    // Mock the GoTrue DELETE fetch call
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    // delete().eq() resolves with no error
    // The default chain already returns { data: null, error: null } for terminal ops.
    // But delete is chained with eq, which is chainable and needs a final resolution.
    // Since delete().eq() doesn't call a terminal like single/maybeSingle,
    // we need to make eq resolve as a promise for this specific call.
    // Let's create a dedicated chain for the delete path.
    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        // First call: getConfigViaAdmin
        return (originalFrom as (...args: unknown[]) => unknown)(table);
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        // Second call: delete
        return {
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await service.deleteConfig(TEST_TENANT_ID);

    // Verify GoTrue delete was called
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `http://localhost:54321/auth/v1/admin/sso/providers/${TEST_PROVIDER_ID}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('should no-op when config does not exist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service, adminDb } = buildService();

    // getConfigViaAdmin returns null
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await service.deleteConfig(TEST_TENANT_ID);

    // Verify no GoTrue DELETE call was made
    expect(fetchSpy).not.toHaveBeenCalled();

    // Verify only one from() call for the admin query, no delete
    expect(adminDb.from).toHaveBeenCalledTimes(1);
  });

  it('should skip GoTrue delete when supabase_provider_id is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const configWithoutProvider = makeSSOConfig({ supabase_provider_id: null });
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({
      data: configWithoutProvider,
      error: null,
    });

    // Mock the delete chain for the DB deletion
    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 2) {
        return {
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await service.deleteConfig(TEST_TENANT_ID);

    // No GoTrue fetch call
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should throw when database delete fails', async () => {
    const existingConfig = makeSSOConfig({ supabase_provider_id: null });
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: existingConfig, error: null });

    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 2) {
        return {
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'foreign key constraint' },
            }),
          }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await expect(service.deleteConfig(TEST_TENANT_ID)).rejects.toThrow(
      'Failed to delete SSO config: foreign key constraint',
    );
  });

  it('should throw when GoTrue delete returns non-OK', async () => {
    const existingConfig = makeSSOConfig();
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: existingConfig, error: null });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Provider not found', { status: 404 }),
    );

    await expect(service.deleteConfig(TEST_TENANT_ID)).rejects.toThrow(
      'Failed to delete SAML provider (HTTP 404): Provider not found',
    );
  });
});

// ---------------------------------------------------------------------------
// toggleActive
// ---------------------------------------------------------------------------

describe('SSOConfigService.toggleActive', () => {
  it('should set is_active to true', async () => {
    const config = makeSSOConfig({ is_active: true });
    const { service, adminDb } = buildService();

    // First from call: update().eq() for toggle
    // Second from call: getConfigViaAdmin for audit
    // Third from call: logAuditEvent insert
    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        // update().eq() returns no error
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        // getConfigViaAdmin
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: config, error: null });
        return chain;
      }
      if (table === 'sso_audit_log') {
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await service.toggleActive(TEST_TENANT_ID, true);

    // Verify the update call included is_active: true but NOT enforcement_enabled
    const updateCall = adminDb.from.mock.results[0]!.value.update;
    expect(updateCall).toHaveBeenCalledWith({ is_active: true });
  });

  it('should set is_active to false and enforcement_enabled to false', async () => {
    const config = makeSSOConfig({ is_active: false, enforcement_enabled: false });
    const { service, adminDb } = buildService();

    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: config, error: null });
        return chain;
      }
      if (table === 'sso_audit_log') {
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await service.toggleActive(TEST_TENANT_ID, false);

    const updateCall = adminDb.from.mock.results[0]!.value.update;
    expect(updateCall).toHaveBeenCalledWith({ is_active: false, enforcement_enabled: false });
  });

  it('should throw when database update fails', async () => {
    const { service, adminDb } = buildService();

    adminDb.from = vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'update error' },
        }),
      }),
    });

    await expect(service.toggleActive(TEST_TENANT_ID, true)).rejects.toThrow(
      'Failed to toggle SSO active state: update error',
    );
  });

  it('should skip audit log when config is not found after toggle', async () => {
    const { service, adminDb } = buildService();

    let fromCallCount = 0;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        // getConfigViaAdmin returns null
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: null, error: null });
        return chain;
      }
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    await service.toggleActive(TEST_TENANT_ID, true);

    // Verify sso_audit_log was NOT called since config was null
    const fromCalls = adminDb.from.mock.calls.map((c: string[]) => c[0]);
    expect(fromCalls).not.toContain('sso_audit_log');
  });
});

// ---------------------------------------------------------------------------
// toggleEnforcement
// ---------------------------------------------------------------------------

describe('SSOConfigService.toggleEnforcement', () => {
  it('should throw when SSO config is not found', async () => {
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await expect(service.toggleEnforcement(TEST_TENANT_ID, true)).rejects.toThrow(
      'SSO config not found for this tenant',
    );
  });

  it('should throw when SSO is not active', async () => {
    const inactiveConfig = makeSSOConfig({ is_active: false });
    const { service, adminDb } = buildService();

    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: inactiveConfig, error: null });

    await expect(service.toggleEnforcement(TEST_TENANT_ID, true)).rejects.toThrow(
      'Cannot change enforcement: SSO is not active',
    );
  });

  it('should set enforcement_enabled to true when SSO is active', async () => {
    const activeConfig = makeSSOConfig({ is_active: true, enforcement_enabled: false });
    const { service, adminDb } = buildService();

    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        // getConfigViaAdmin
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: activeConfig, error: null });
        return chain;
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        // update().eq()
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sso_audit_log') {
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await service.toggleEnforcement(TEST_TENANT_ID, true);

    const updateCall = adminDb.from.mock.results[1]!.value.update;
    expect(updateCall).toHaveBeenCalledWith({ enforcement_enabled: true });
  });

  it('should set enforcement_enabled to false when SSO is active', async () => {
    const activeConfig = makeSSOConfig({ is_active: true, enforcement_enabled: true });
    const { service, adminDb } = buildService();

    let fromCallCount = 0;
    const originalFrom = adminDb.from;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: activeConfig, error: null });
        return chain;
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sso_audit_log') {
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return (originalFrom as (...args: unknown[]) => unknown)(table);
    });

    await service.toggleEnforcement(TEST_TENANT_ID, false);

    const updateCall = adminDb.from.mock.results[1]!.value.update;
    expect(updateCall).toHaveBeenCalledWith({ enforcement_enabled: false });
  });

  it('should throw when database update fails', async () => {
    const activeConfig = makeSSOConfig({ is_active: true });
    const { service, adminDb } = buildService();

    let fromCallCount = 0;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: activeConfig, error: null });
        return chain;
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'enforcement update failed' },
            }),
          }),
        };
      }
      return {};
    });

    await expect(service.toggleEnforcement(TEST_TENANT_ID, true)).rejects.toThrow(
      'Failed to toggle SSO enforcement: enforcement update failed',
    );
  });

  it('should log enforcement_changed audit event', async () => {
    const activeConfig = makeSSOConfig({ is_active: true });
    const { service, adminDb } = buildService();

    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });

    let fromCallCount = 0;
    adminDb.from = vi.fn().mockImplementation((table: string) => {
      fromCallCount++;
      if (table === 'sso_config' && fromCallCount === 1) {
        const chain = createMockChain();
        chain.maybeSingle.mockResolvedValue({ data: activeConfig, error: null });
        return chain;
      }
      if (table === 'sso_config' && fromCallCount === 2) {
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sso_audit_log') {
        return { insert: insertMock };
      }
      return {};
    });

    await service.toggleEnforcement(TEST_TENANT_ID, true);

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TEST_TENANT_ID,
        sso_config_id: TEST_CONFIG_ID,
        event_type: 'enforcement_changed',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// checkDomainSSO
// ---------------------------------------------------------------------------

describe('SSOConfigService.checkDomainSSO', () => {
  it('should return hasSso true when domain matches active config', async () => {
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({
      data: { is_active: true, enforcement_enabled: true },
      error: null,
    });

    const result = await service.checkDomainSSO('example.com');

    expect(result).toEqual({ hasSso: true, enforced: true });
    expect(adminDb._chain.contains).toHaveBeenCalledWith('allowed_domains', ['example.com']);
    expect(adminDb._chain.eq).toHaveBeenCalledWith('is_active', true);
  });

  it('should return hasSso false when no match found', async () => {
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await service.checkDomainSSO('unknown.com');

    expect(result).toEqual({ hasSso: false, enforced: false });
  });

  it('should return enforced false when enforcement is disabled', async () => {
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({
      data: { is_active: true, enforcement_enabled: false },
      error: null,
    });

    const result = await service.checkDomainSSO('example.com');

    expect(result).toEqual({ hasSso: true, enforced: false });
  });

  it('should throw when database query fails', async () => {
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'query timeout' },
    });

    await expect(service.checkDomainSSO('example.com')).rejects.toThrow(
      'Failed to check domain SSO: query timeout',
    );
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('SSOConfigService.testConnection', () => {
  it('should return errors when no config exists', async () => {
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataReachable).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.certificateValid).toBe(false);
    expect(result.errors).toContain('No SSO configuration found for this tenant');
    expect(result.acsUrl).toBe('http://localhost:54321/auth/v1/sso/saml/acs');
  });

  it('should return errors when config has no metadata URL', async () => {
    const configNoUrl = makeSSOConfig({ metadata_url: null });
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: configNoUrl, error: null });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.errors).toContain('No metadata URL configured');
    expect(result.metadataReachable).toBe(false);
  });

  it('should return diagnostics with valid SAML metadata', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    const validMetadataXml = `
      <EntityDescriptor entityID="https://idp.example.com">
        <IDPSSODescriptor>
          <SingleSignOnService />
          <X509Certificate>MIIDpDCCAoygAwIBAgIGAX...</X509Certificate>
        </IDPSSODescriptor>
      </EntityDescriptor>
    `;

    mockFetchMetadata.mockResolvedValueOnce({ status: 200, body: validMetadataXml });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataReachable).toBe(true);
    expect(result.metadataValid).toBe(true);
    expect(result.certificateValid).toBe(true);
    expect(result.entityId).toBe('https://idp.example.com');
    expect(result.errors).toHaveLength(0);
  });

  it('should report error when metadata endpoint returns non-OK', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    mockFetchMetadata.mockResolvedValueOnce({ status: 404, body: 'Not Found' });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataReachable).toBe(false);
    expect(result.errors).toContain('Metadata endpoint returned HTTP 404');
  });

  it('should report error when fetch throws', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    mockFetchMetadata.mockRejectedValueOnce(new Error('DNS resolution failed'));

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataReachable).toBe(false);
    expect(result.errors).toContain('Failed to reach metadata URL: DNS resolution failed');
  });

  it('should report error when fetch throws non-Error object', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    mockFetchMetadata.mockRejectedValueOnce('string error');

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.errors).toContain('Failed to reach metadata URL: Unknown error fetching metadata');
  });

  it('should report invalid metadata when EntityDescriptor is missing', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    mockFetchMetadata.mockResolvedValueOnce({ status: 200, body: '<NotSAML>some content</NotSAML>' });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataReachable).toBe(true);
    expect(result.metadataValid).toBe(false);
    expect(result.errors).toContain(
      'Metadata XML does not contain required SAML IdP descriptors',
    );
  });

  it('should report invalid metadata when IDPSSODescriptor is missing', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    mockFetchMetadata.mockResolvedValueOnce({ status: 200, body: '<EntityDescriptor>no idp descriptor</EntityDescriptor>' });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataReachable).toBe(true);
    expect(result.metadataValid).toBe(false);
    expect(result.errors).toContain(
      'Metadata XML does not contain required SAML IdP descriptors',
    );
  });

  it('should accept metadata with SingleSignOnService instead of IDPSSODescriptor', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    const xml = `
      <EntityDescriptor entityID="https://idp.example.com">
        <SingleSignOnService Location="https://idp.example.com/sso" />
        <X509Certificate>MIID...</X509Certificate>
      </EntityDescriptor>
    `;

    mockFetchMetadata.mockResolvedValueOnce({ status: 200, body: xml });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataValid).toBe(true);
  });

  it('should report missing certificate when X509Certificate not in metadata', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    const xml = `
      <EntityDescriptor entityID="https://idp.example.com">
        <IDPSSODescriptor>
          <SingleSignOnService />
        </IDPSSODescriptor>
      </EntityDescriptor>
    `;

    mockFetchMetadata.mockResolvedValueOnce({ status: 200, body: xml });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.metadataValid).toBe(true);
    expect(result.certificateValid).toBe(false);
    expect(result.errors).toContain('No X509Certificate found in metadata');
  });

  it('should return null entityId when entityID attribute is not in metadata', async () => {
    const config = makeSSOConfig();
    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: config, error: null });

    const xml = `
      <EntityDescriptor>
        <IDPSSODescriptor>
          <X509Certificate>MIID...</X509Certificate>
        </IDPSSODescriptor>
      </EntityDescriptor>
    `;

    mockFetchMetadata.mockResolvedValueOnce({ status: 200, body: xml });

    const result = await service.testConnection(TEST_TENANT_ID);

    expect(result.entityId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertSSOIdentity
// ---------------------------------------------------------------------------

describe('SSOConfigService.upsertSSOIdentity', () => {
  it('should upsert identity with all params', async () => {
    const { service, adminDb } = buildService();

    // upsert chain resolves
    adminDb._chain.upsert.mockResolvedValueOnce({ data: null, error: null });
    // audit log insert
    adminDb._chain.insert.mockResolvedValueOnce({ data: null, error: null });

    // Need to re-wire since upsert is terminal here (no more chaining after it).
    // The table-name dispatch below doesn't need a call counter — the same
    // table always routes to the same mock regardless of call ordinal.
    const upsertMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });

    adminDb.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'sso_identity') {
        return { upsert: upsertMock };
      }
      if (table === 'sso_audit_log') {
        return { insert: insertMock };
      }
      return {};
    });

    await service.upsertSSOIdentity({
      tenantId: TEST_TENANT_ID,
      userId: 'user-1',
      ssoConfigId: TEST_CONFIG_ID,
      externalSubjectId: 'ext-subject-1',
      idpIssuer: 'https://idp.example.com',
    });

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TEST_TENANT_ID,
        user_id: 'user-1',
        sso_config_id: TEST_CONFIG_ID,
        external_subject_id: 'ext-subject-1',
        idp_issuer: 'https://idp.example.com',
      }),
      { onConflict: 'tenant_id,user_id' },
    );

    // Verify audit log was written with login_success
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'login_success',
        user_id: 'user-1',
      }),
    );
  });

  it('should set idp_issuer to null when not provided', async () => {
    const { service, adminDb } = buildService();

    const upsertMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });

    adminDb.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'sso_identity') {
        return { upsert: upsertMock };
      }
      if (table === 'sso_audit_log') {
        return { insert: insertMock };
      }
      return {};
    });

    await service.upsertSSOIdentity({
      tenantId: TEST_TENANT_ID,
      userId: 'user-1',
      ssoConfigId: TEST_CONFIG_ID,
      externalSubjectId: 'ext-1',
    });

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ idp_issuer: null }),
      expect.anything(),
    );
  });

  it('should throw when upsert fails', async () => {
    const { service, adminDb } = buildService();

    adminDb.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'sso_identity') {
        return {
          upsert: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'upsert conflict' },
          }),
        };
      }
      return {};
    });

    await expect(
      service.upsertSSOIdentity({
        tenantId: TEST_TENANT_ID,
        userId: 'user-1',
        ssoConfigId: TEST_CONFIG_ID,
        externalSubjectId: 'ext-1',
      }),
    ).rejects.toThrow('Failed to upsert SSO identity: upsert conflict');
  });
});

// ---------------------------------------------------------------------------
// getSSOMembers
// ---------------------------------------------------------------------------

describe('SSOConfigService.getSSOMembers', () => {
  it('should return mapped members with profile data', async () => {
    const { service, db } = buildService();

    const mockIdentities = [
      {
        user_id: 'user-1',
        external_subject_id: 'ext-1',
        first_login_at: '2026-01-01T00:00:00Z',
        last_login_at: '2026-01-15T00:00:00Z',
      },
      {
        user_id: 'user-2',
        external_subject_id: 'ext-2',
        first_login_at: '2026-01-02T00:00:00Z',
        last_login_at: '2026-01-16T00:00:00Z',
      },
    ];

    const mockProfiles = [
      { id: 'user-1', email: 'alice@example.com', display_name: 'Alice' },
    ];

    // First query: sso_identity → eq() resolves
    db._chain.eq.mockResolvedValueOnce({ data: mockIdentities, error: null });
    // Second query: profile → in() resolves
    db._chain.in.mockResolvedValueOnce({ data: mockProfiles, error: null });

    const result = await service.getSSOMembers(TEST_TENANT_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      user_id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      external_subject_id: 'ext-1',
      first_login_at: '2026-01-01T00:00:00Z',
      last_login_at: '2026-01-15T00:00:00Z',
    });
    expect(result[1]).toEqual({
      user_id: 'user-2',
      email: '',
      display_name: null,
      external_subject_id: 'ext-2',
      first_login_at: '2026-01-02T00:00:00Z',
      last_login_at: '2026-01-16T00:00:00Z',
    });
  });

  it('should return empty array when data is null', async () => {
    const { service, db } = buildService();

    db._chain.eq.mockResolvedValueOnce({ data: null, error: null });

    const result = await service.getSSOMembers(TEST_TENANT_ID);

    expect(result).toEqual([]);
  });

  it('should throw when query fails', async () => {
    const { service, db } = buildService();

    db._chain.eq.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied' },
    });

    await expect(service.getSSOMembers(TEST_TENANT_ID)).rejects.toThrow(
      'Failed to fetch SSO members: permission denied',
    );
  });
});

// ---------------------------------------------------------------------------
// GoTrue admin config (private, tested via public methods)
// ---------------------------------------------------------------------------

describe('SSOConfigService GoTrue admin config', () => {
  it('should throw when the Supabase URL is missing', async () => {
    configHolder.supabaseUrl = undefined;

    const { service, adminDb } = buildService();

    // saveConfig with no existing config triggers createSamlProvider
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY',
    );
  });

  it('should throw when the Supabase secret key is missing', async () => {
    configHolder.secretKey = undefined;

    const { service, adminDb } = buildService();
    adminDb._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await expect(service.saveConfig(TEST_TENANT_ID, makeSaveInput())).rejects.toThrow(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY',
    );
  });
});
