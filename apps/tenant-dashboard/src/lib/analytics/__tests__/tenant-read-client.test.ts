/**
 * createTenantReadClient — the dashboard's row-policy read factory.
 *
 * Pins the two security-relevant choices per constructed client:
 *   1. IDENTITY — reader credentials when CLICKHOUSE_READ_USER is configured,
 *      writer fallback (with a one-time warning) when it isn't.
 *   2. SCOPE — SQL_tenant_id (+ SQL_app_id when app-scoped) baked in at the
 *      CLIENT level, so no individual query through it can drop the scope.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { cfg, createdConfigs } = vi.hoisted(() => ({
  cfg: {
    host: 'http://ch.test:8123' as string | undefined,
    password: 'writer-secret' as string | undefined,
    readUser: undefined as string | undefined,
    readPassword: undefined as string | undefined,
    allowUnscoped: undefined as string | undefined,
  },
  createdConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn((config: Record<string, unknown>) => {
    createdConfigs.push(config);
    return { __client: true, close: vi.fn() };
  }),
}));

vi.mock('../../../config-global.server', () => ({
  get CLICKHOUSE_HOST() {
    return cfg.host;
  },
  get CLICKHOUSE_PASSWORD() {
    return cfg.password;
  },
  get CLICKHOUSE_READ_USER() {
    return cfg.readUser;
  },
  get CLICKHOUSE_READ_PASSWORD() {
    return cfg.readPassword;
  },
  get CLICKHOUSE_ALLOW_UNSCOPED_READS() {
    return cfg.allowUnscoped;
  },
}));

import { createTenantReadClient, DEFAULT_QUERY_SETTINGS } from '../client';

beforeEach(() => {
  vi.clearAllMocks();
  createdConfigs.length = 0;
  cfg.host = 'http://ch.test:8123';
  cfg.password = 'writer-secret';
  cfg.readUser = undefined;
  cfg.readPassword = undefined;
  cfg.allowUnscoped = undefined;
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTenantReadClient', () => {
  it('returns null (with a config warning) when ClickHouse is not configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cfg.host = undefined;
    expect(createTenantReadClient({ tenantId: 't-1' })).toBeNull();
    expect(createdConfigs).toEqual([]);
    warn.mockRestore();
  });

  it('authenticates as the READ user and bakes the full scope into client-level settings', () => {
    cfg.readUser = 'analytics_reader';
    cfg.readPassword = 'reader-secret';

    createTenantReadClient({ tenantId: 'tenant-1', appId: 'app-1' });

    expect(createdConfigs).toEqual([
      {
        url: 'http://ch.test:8123',
        username: 'analytics_reader',
        password: 'reader-secret',
        database: 'default',
        request_timeout: 30000,
        clickhouse_settings: {
          ...DEFAULT_QUERY_SETTINGS,
          SQL_tenant_id: 'tenant-1',
          SQL_app_id: 'app-1',
        },
      },
    ]);
  });

  it('omits SQL_app_id for a tenant-only scope (tenant-wide reads must not send a bogus app)', () => {
    cfg.readUser = 'analytics_reader';
    cfg.readPassword = 'reader-secret';

    createTenantReadClient({ tenantId: 'tenant-9' });

    expect(createdConfigs[0]!.clickhouse_settings).toEqual({
      ...DEFAULT_QUERY_SETTINGS,
      SQL_tenant_id: 'tenant-9',
    });
  });

  it('falls back to the WRITER identity when no read user is configured — and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    createTenantReadClient({ tenantId: 't-1' });
    createTenantReadClient({ tenantId: 't-2' });

    expect(createdConfigs[0]).toEqual({
      url: 'http://ch.test:8123',
      username: undefined,
      password: 'writer-secret',
      database: 'default',
      request_timeout: 30000,
      clickhouse_settings: {
        ...DEFAULT_QUERY_SETTINGS,
        SQL_tenant_id: 't-1',
      },
    });
    const policyWarnings = warn.mock.calls.filter(([m]) =>
      String(m).includes('CLICKHOUSE_READ_USER unset'),
    );
    expect(policyWarnings).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('createTenantReadClient — production fail-closed', () => {
  it('throws instead of downgrading to the writer identity in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => createTenantReadClient({ tenantId: 't-1' })).toThrow(
      /CLICKHOUSE_READ_USER is not set/,
    );
    // The point of the throw: no client, so no un-policed read can happen.
    expect(createdConfigs).toEqual([]);
  });

  it('still constructs the reader client in production once the read user is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    cfg.readUser = 'analytics_reader';
    cfg.readPassword = 'reader-secret';

    createTenantReadClient({ tenantId: 't-1' });

    expect(createdConfigs).toEqual([
      {
        url: 'http://ch.test:8123',
        username: 'analytics_reader',
        password: 'reader-secret',
        database: 'default',
        request_timeout: 30000,
        clickhouse_settings: { ...DEFAULT_QUERY_SETTINGS, SQL_tenant_id: 't-1' },
      },
    ]);
  });

  it('lets a self-host opt out explicitly and fall back to the writer identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    cfg.allowUnscoped = 'true';

    createTenantReadClient({ tenantId: 't-1' });

    expect(createdConfigs).toEqual([
      {
        url: 'http://ch.test:8123',
        username: undefined,
        password: 'writer-secret',
        database: 'default',
        request_timeout: 30000,
        clickhouse_settings: { ...DEFAULT_QUERY_SETTINGS, SQL_tenant_id: 't-1' },
      },
    ]);
    warn.mockRestore();
  });

  it('does not accept a non-boolean opt-out value as consent', () => {
    vi.stubEnv('NODE_ENV', 'production');
    cfg.allowUnscoped = 'yes-please';

    expect(() => createTenantReadClient({ tenantId: 't-1' })).toThrow(
      /CLICKHOUSE_READ_USER is not set/,
    );
    expect(createdConfigs).toEqual([]);
  });

  // The warn-once path is covered above; the flag is module state, so asserting
  // it again here would depend on test order. What matters is that a dev
  // without the read user still gets a working, correctly scoped client. A
  // throw here fails the test on its own, so the shape assertion carries it.
  it('still builds the scoped writer client outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'development');

    createTenantReadClient({ tenantId: 't-1' });

    expect(createdConfigs).toEqual([
      {
        url: 'http://ch.test:8123',
        username: undefined,
        password: 'writer-secret',
        database: 'default',
        request_timeout: 30000,
        clickhouse_settings: {
          ...DEFAULT_QUERY_SETTINGS,
          SQL_tenant_id: 't-1',
        },
      },
    ]);
    warn.mockRestore();
  });
});
