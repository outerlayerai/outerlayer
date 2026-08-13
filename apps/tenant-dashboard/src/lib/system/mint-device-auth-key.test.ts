/**
 * mint-device-auth-key — mints the key a consumed device_auth_request row
 * is redeemed for. Every client here is service-role (see the file's own
 * docstring for why); this exercises the mint call shape, the app/org name
 * lookups, and that an audit-write failure never turns a successful mint
 * into a thrown error.
 */

import {
  seedSupabaseMswState,
  seedMembershipMswState,
  seedAuditLogMswState,
  getInsertedAuditLogRows,
} from '@/test-helpers/msw-handlers';

import type { DeviceAuthRequestRow } from './device-auth';

const mockMintApiKey = vi.fn();
vi.mock('@repo/api-key-service', () => ({
  mintApiKey: (...args: unknown[]) => mockMintApiKey(...args),
}));

import { mintDeviceAuthApiKey } from './mint-device-auth-key';

const TENANT = 'tenant-1';
const APP = 'app-1';

function consumedRow(overrides: Partial<DeviceAuthRequestRow> = {}): DeviceAuthRequestRow {
  return {
    id: 'r1',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    user_code: 'AAAA-BBBB',
    device_code_digest: 'irrelevant-here',
    status: 'consumed',
    tenant_id: TENANT,
    app_id: APP,
    environment_id: 'env-1',
    approver_membership_id: 'member-1',
    approved_at: new Date().toISOString(),
    consumed_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockMintApiKey.mockReset();
  mockMintApiKey.mockResolvedValue({
    plaintext: 'sk_outerlayer_minted',
    row: { id: 'key-1', api_key_id: 'k-1', name: 'CLI Device Login - r1' },
  });
  seedSupabaseMswState({ apps: [{ id: APP, tenant_id: TENANT, name: 'My App' }] });
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT, organization_name: 'acme' }] });
});

it('mints with the fixed trace.write permission, the row environment, and the approver as actor', async () => {
  const before = Date.now();
  const result = await mintDeviceAuthApiKey(consumedRow());
  const after = Date.now();

  expect(result).toEqual({ plaintext: 'sk_outerlayer_minted', appName: 'My App', orgName: 'acme' });
  expect(mockMintApiKey).toHaveBeenCalledTimes(1);
  expect(mockMintApiKey).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: TENANT,
      appId: APP,
      environmentId: 'env-1',
      permissions: ['trace.write'],
      actorMembershipId: 'member-1',
      createdBy: null,
      name: 'CLI Device Login - r1',
    }),
  );

  // The key TTL is exactly 30 days: expiresAt sits between now+30d captured
  // just before and just after the call, pinning the 30*24*60*60*1000
  // arithmetic without flaking on wall-clock jitter.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const expiresAtArg = mockMintApiKey.mock.calls[0]![0] as { expiresAt: string };
  const expiresAtMs = new Date(expiresAtArg.expiresAt).getTime();
  expect(expiresAtMs).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
  expect(expiresAtMs).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
});

it('names the key after the device_auth_request row id — collision-proof even for repeated logins from the same device', async () => {
  await mintDeviceAuthApiKey(consumedRow({ id: 'a-different-row-id' }));
  expect(mockMintApiKey).toHaveBeenCalledWith(expect.objectContaining({ name: 'CLI Device Login - a-different-row-id' }));
});

it('writes an api_key_created audit row attributed to the approver, never carrying plaintext or digest', async () => {
  await mintDeviceAuthApiKey(consumedRow());

  const rows = getInsertedAuditLogRows();
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action_type: 'api_key_created',
        tenant_id: TENANT,
        target_type: 'api_key',
        target_id: 'key-1',
      }),
    ]),
  );
  const auditRow = rows.find((r) => r.action_type === 'api_key_created');
  expect(JSON.stringify(auditRow)).not.toContain('sk_outerlayer_minted');
});

it('falls back to an empty appName when the app row is gone and null orgName when the tenant row is gone', async () => {
  seedSupabaseMswState({ apps: [] });
  seedMembershipMswState({ tenants: [] });

  const result = await mintDeviceAuthApiKey(consumedRow());

  expect(result).toEqual({ plaintext: 'sk_outerlayer_minted', appName: '', orgName: null });
});

it('throws if the row is missing tenant_id — a row that never passed through approval', async () => {
  await expect(mintDeviceAuthApiKey(consumedRow({ tenant_id: null }))).rejects.toThrow(
    'device_auth_request row is missing tenant_id/app_id at mint time',
  );
  expect(mockMintApiKey).not.toHaveBeenCalled();
});

it('throws if the row is missing app_id — same guard, other column', async () => {
  await expect(mintDeviceAuthApiKey(consumedRow({ app_id: null }))).rejects.toThrow(
    'device_auth_request row is missing tenant_id/app_id at mint time',
  );
  expect(mockMintApiKey).not.toHaveBeenCalled();
});

it('a mint failure propagates rather than being swallowed', async () => {
  mockMintApiKey.mockRejectedValue(new Error('uc_api_key violation'));
  await expect(mintDeviceAuthApiKey(consumedRow())).rejects.toThrow('uc_api_key violation');
});

it('an audit-log write failure is swallowed — the mint still resolves with the key', async () => {
  seedAuditLogMswState({ forceInsertError: { message: 'audit insert exploded' } });

  const result = await mintDeviceAuthApiKey(consumedRow());

  expect(result).toEqual({ plaintext: 'sk_outerlayer_minted', appName: 'My App', orgName: 'acme' });
  expect(getInsertedAuditLogRows()).toEqual([]);
});

it('a row with no approver still mints and audits with null attribution', async () => {
  const result = await mintDeviceAuthApiKey(consumedRow({ approver_membership_id: null }));

  expect(result).toEqual({ plaintext: 'sk_outerlayer_minted', appName: 'My App', orgName: 'acme' });
  expect(mockMintApiKey).toHaveBeenCalledWith(expect.objectContaining({ actorMembershipId: null }));
  const auditRow = getInsertedAuditLogRows().find((r) => r.action_type === 'api_key_created');
  expect(auditRow).toMatchObject({ actor_id: null });
});
