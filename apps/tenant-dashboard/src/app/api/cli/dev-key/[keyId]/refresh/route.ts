/**
 * CLI Dev Key Refresh API Route
 *
 * POST /api/cli/dev-key/:keyId/refresh
 *
 * Refreshes a dev API key by revoking the old key and creating a new one.
 * Contract:
 * - Auth: Bearer token (Supabase JWT)
 * - Revokes old key, creates new key with fresh 30-day TTL
 * - Response: { key, key_id, expires_at }
 */

import { NextResponse } from 'next/server';
import { createCliSupabaseClient } from '../../../auth-helper';
import { resolveCliTenant } from '../../../resolve-cli-tenant';
import { mintApiKey } from '@repo/api-key-service';
import { API_KEY_PEPPER } from '@/config-global.server';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { serverLogger } from '@/lib/observability/server-logger';

type RouteContext = {
  params: Promise<{ keyId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    // Step 1: Authenticate user via Bearer token
    const supabase = createCliSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
    }
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    // Step 2: Resolve the tenant (header → last-active preference → sole
    // membership → deny).
    const tenantResult = await resolveCliTenant(supabase, user, request);
    if (!tenantResult.ok) {
      return NextResponse.json({ error: tenantResult.error }, { status: tenantResult.status });
    }
    const tenantId = tenantResult.tenantId;

    // Rebuild the client WITH the resolved tenant attached as X-Tenant-Id so
    // every query below runs scoped to it.
    const tenantSupabase = createCliSupabaseClient(request, tenantId)!;

    // Step 3: Await and extract keyId from route params
    const { keyId } = await context.params;

    // Step 4: Verify key belongs to user's tenant and get metadata
    const { data: apiKey, error: fetchError } = await tenantSupabase
      .from('api_key')
      .select('api_key_id, name, app_id, tenant_id, environment_id')
      .eq('api_key_id', keyId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !apiKey) {
      return NextResponse.json(
        { error: 'API key not found or access denied' },
        { status: 404 }
      );
    }

    // Step 5: Mint a fresh dev key with replaceExisting — delete-by-(name,app_id)
    // then insert, yielding a new plaintext + api_key_id + digest and a fresh
    // 30-day expiry. The old row's secret cascades on delete, revoking it.
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    let plaintext: string;
    let newApiKeyId: string;
    try {
      const result = await mintApiKey({
        rowClient: tenantSupabase,
        adminClient: createSupabaseAdminClient(),
        pepper: API_KEY_PEPPER,
        tenantId,
        appId: apiKey.app_id,
        name: apiKey.name,
        environmentId: apiKey.environment_id,
        permissions: ['trace.write'],
        expiresAt: expiresAt.toISOString(),
        prefix: 'sk_outerlayer_dev_',
        replaceExisting: true,
      });
      plaintext = result.plaintext;
      newApiKeyId = result.row.api_key_id;
    } catch (err) {
      console.error('[CLI API] Failed to refresh dev key:', err);
      return NextResponse.json(
        { error: 'Failed to refresh API key' },
        { status: 500 }
      );
    }

    // Step 6: Return new key details per contract
    return NextResponse.json({
      key: plaintext,
      key_id: newApiKeyId,
      expires_at: expiresAt.toISOString(),
    });

  } catch (error) {
    await serverLogger.error(error as Error, {
      context: '[CLI API] POST /api/cli/dev-key/:keyId/refresh failed',
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
