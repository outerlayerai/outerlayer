import {
  getSupabaseAdmin,
  checkTableExists,
  requirePrerequisite,
  createAuthenticatedUser,
  cleanupTestUsers,
  type PrerequisiteCheck,
} from '../../lib/test-utils';

/**
 * `sso_config` tenant isolation and permission gating, against a REAL local
 * Supabase through REAL signed-in user clients — the only way to prove the
 * RLS policies (`schemas/65-sso.sql`) and the `authorize()` RPC scope
 * correctly (a mocked client passes regardless).
 *
 * Seeds (`12-rbac.sql`, verified against this database): `sso_config.read`/
 * `.insert`/`.update` are owner+admin; `sso_config.delete` is owner-only.
 * read/write roles hold none of the four.
 *
 * RLS semantics relied on (documented pattern from the audit-log suite):
 *   - SELECT under a denying policy returns 0 rows + null error.
 *   - INSERT under a denying policy returns a row-level security error.
 *   - UPDATE/DELETE under a denying policy return 0 affected rows + null
 *     error (USING acts as a filter) — verify the row is UNCHANGED.
 */

describe('sso_config tenant isolation and permission gating', () => {
  const supabaseAdmin = getSupabaseAdmin();
  let tableCheck: PrerequisiteCheck;

  beforeAll(async () => {
    tableCheck = await checkTableExists('sso_config');
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  /** Seeds one sso_config row via service_role and returns its id. */
  async function seedSSOConfig(tenantId: string, metadataUrl: string): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('sso_config')
      .insert({
        tenant_id: tenantId,
        metadata_url: metadataUrl,
        allowed_domains: ['example.com'],
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  // ---------------------------------------------------------------------
  // The read-gate pin: a member without sso_config.read fails
  // authorize('sso_config.read') at the DB — the gate covering all three
  // reads (getSSOConfig, testSSOConnection, getSSOMembers).
  // ---------------------------------------------------------------------

  it('grants sso_config.read to owner and admin, denies it to read- and write-role members', async () => {
    requirePrerequisite(tableCheck);
    const [owner, admin, reader, writer] = await Promise.all([
      createAuthenticatedUser('owner'),
      createAuthenticatedUser('admin'),
      createAuthenticatedUser('read'),
      createAuthenticatedUser('write'),
    ]);

    const [ownerAuthz, adminAuthz, readerAuthz, writerAuthz] = await Promise.all([
      owner.client.rpc('authorize', { requested_permission: 'sso_config.read' }),
      admin.client.rpc('authorize', { requested_permission: 'sso_config.read' }),
      reader.client.rpc('authorize', { requested_permission: 'sso_config.read' }),
      writer.client.rpc('authorize', { requested_permission: 'sso_config.read' }),
    ]);

    expect(ownerAuthz).toMatchObject({ data: true, error: null });
    expect(adminAuthz).toMatchObject({ data: true, error: null });
    expect(readerAuthz).toMatchObject({ data: false, error: null });
    expect(writerAuthz).toMatchObject({ data: false, error: null });
  });

  it('grants sso_config.delete to owner only — admin holds update but not delete', async () => {
    requirePrerequisite(tableCheck);
    const [owner, admin] = await Promise.all([
      createAuthenticatedUser('owner'),
      createAuthenticatedUser('admin'),
    ]);

    const [ownerAuthz, adminAuthz] = await Promise.all([
      owner.client.rpc('authorize', { requested_permission: 'sso_config.delete' }),
      admin.client.rpc('authorize', { requested_permission: 'sso_config.delete' }),
    ]);

    expect(ownerAuthz).toMatchObject({ data: true, error: null });
    expect(adminAuthz).toMatchObject({ data: false, error: null });
  });

  // ---------------------------------------------------------------------
  // S-g1-1: sso_config is tenant-isolated; writes denied to non-owner/admin.
  // ---------------------------------------------------------------------

  it('owner reads ONLY their own tenant row — another tenant\'s config is invisible', async () => {
    requirePrerequisite(tableCheck);
    const ownerA = await createAuthenticatedUser('owner');
    const ownerB = await createAuthenticatedUser('owner');

    const mineId = await seedSSOConfig(ownerA.tenantId, 'https://idp-a.example.com/metadata');
    const theirsId = await seedSSOConfig(ownerB.tenantId, 'https://idp-b.example.com/metadata');

    const { data: visible, error } = await ownerA.client
      .from('sso_config')
      .select('id, tenant_id');

    expect(error).toBeNull();
    expect(visible!.every((row) => row.tenant_id === ownerA.tenantId)).toBe(true);
    const visibleIds = visible!.map((row) => row.id);
    expect(visibleIds).toContain(mineId);
    expect(visibleIds).not.toContain(theirsId);

    const { data: byId, error: byIdError } = await ownerA.client
      .from('sso_config')
      .select('id')
      .eq('id', theirsId);
    expect(byIdError).toBeNull();
    expect(byId).toEqual([]);
  });

  it('read- and write-role members see zero sso_config rows even when their tenant has one', async () => {
    requirePrerequisite(tableCheck);
    const [reader, writer] = await Promise.all([
      createAuthenticatedUser('read'),
      createAuthenticatedUser('write'),
    ]);
    await seedSSOConfig(reader.tenantId, 'https://idp-reader.example.com/metadata');
    await seedSSOConfig(writer.tenantId, 'https://idp-writer.example.com/metadata');

    const [readerRows, writerRows] = await Promise.all([
      reader.client.from('sso_config').select('id').eq('tenant_id', reader.tenantId),
      writer.client.from('sso_config').select('id').eq('tenant_id', writer.tenantId),
    ]);

    expect(readerRows.error).toBeNull();
    expect(readerRows.data).toEqual([]);
    expect(writerRows.error).toBeNull();
    expect(writerRows.data).toEqual([]);
  });

  it('a read-role member cannot insert an sso_config row for their own tenant', async () => {
    requirePrerequisite(tableCheck);
    const reader = await createAuthenticatedUser('read');

    const { error } = await reader.client.from('sso_config').insert({
      tenant_id: reader.tenantId,
      metadata_url: 'https://idp-blocked.example.com/metadata',
      allowed_domains: ['blocked.example.com'],
    });

    expect(error).not.toBeNull();

    const { data: rows } = await supabaseAdmin
      .from('sso_config')
      .select('id')
      .eq('tenant_id', reader.tenantId);
    expect(rows).toEqual([]);
  });

  it('a write-role member cannot update an existing sso_config row (RLS filters it, no rows change)', async () => {
    requirePrerequisite(tableCheck);
    const writer = await createAuthenticatedUser('write');
    const configId = await seedSSOConfig(writer.tenantId, 'https://idp-original.example.com/metadata');

    const { error } = await writer.client
      .from('sso_config')
      .update({ metadata_url: 'https://idp-tampered.example.com/metadata' })
      .eq('id', configId);
    expect(error).toBeNull();

    const { data: unchanged } = await supabaseAdmin
      .from('sso_config')
      .select('metadata_url')
      .eq('id', configId)
      .single();
    expect(unchanged!.metadata_url).toBe('https://idp-original.example.com/metadata');
  });

  it('an admin (update but not delete) cannot delete an sso_config row', async () => {
    requirePrerequisite(tableCheck);
    const admin = await createAuthenticatedUser('admin');
    const configId = await seedSSOConfig(admin.tenantId, 'https://idp-admin.example.com/metadata');

    const { error } = await admin.client.from('sso_config').delete().eq('id', configId);
    expect(error).toBeNull();

    const { data: stillThere } = await supabaseAdmin
      .from('sso_config')
      .select('id')
      .eq('id', configId);
    expect(stillThere).toHaveLength(1);
  });

  it('the owner can delete their own sso_config row', async () => {
    requirePrerequisite(tableCheck);
    const owner = await createAuthenticatedUser('owner');
    const configId = await seedSSOConfig(owner.tenantId, 'https://idp-owner.example.com/metadata');

    const { error } = await owner.client.from('sso_config').delete().eq('id', configId);
    expect(error).toBeNull();

    const { data: gone } = await supabaseAdmin.from('sso_config').select('id').eq('id', configId);
    expect(gone).toEqual([]);
  });
});
