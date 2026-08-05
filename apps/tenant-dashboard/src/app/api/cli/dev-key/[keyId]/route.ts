/**
 * CLI Dev Key Deletion API Route
 *
 * DELETE /api/cli/dev-key/:keyId
 *
 * Revokes a dev API key.
 * Contract:
 * - Auth: Bearer token (Supabase JWT)
 * - Deletes the api_key row (its secret digest cascades — that IS revocation)
 * - Response: 204 No Content on success
 */

import { NextResponse } from 'next/server';
import { createCliSupabaseClient } from '../../auth-helper';
import { resolveCliTenant } from '../../resolve-cli-tenant';
import { serverLogger } from '@/lib/observability/server-logger';

type RouteContext = {
  params: Promise<{ keyId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
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

    // Step 4: Verify key belongs to user's tenant
    const { data: apiKey, error: fetchError } = await tenantSupabase
      .from('api_key')
      .select('api_key_id, tenant_id')
      .eq('api_key_id', keyId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !apiKey) {
      return NextResponse.json(
        { error: 'API key not found or access denied' },
        { status: 404 }
      );
    }

    // Step 5: Delete the api_key row. The private.api_key_secret digest cascades
    // (ON DELETE CASCADE), so the key stops verifying — deletion IS revocation.
    const { error: deleteError } = await tenantSupabase
      .from('api_key')
      .delete()
      .eq('api_key_id', keyId)
      .eq('tenant_id', tenantId);

    if (deleteError) {
      return NextResponse.json(
        { error: `Failed to delete API key: ${deleteError.message}` },
        { status: 500 }
      );
    }

    // Step 6: Return 204 No Content
    return new NextResponse(null, { status: 204 });

  } catch (error) {
    await serverLogger.error(error as Error, {
      context: '[CLI API] DELETE /api/cli/dev-key/:keyId failed',
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
