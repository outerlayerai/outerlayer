/**
 * CLI Apps API Route
 *
 * GET /api/cli/apps
 *
 * Returns list of apps accessible to the authenticated user.
 * Contract:
 * - Auth: Bearer token (Supabase JWT)
 * - Response: { apps: [{ id, name, tenant_id, tenant_name, created_at }] }
 */

import { NextResponse } from 'next/server';
import { createCliSupabaseClient } from '../auth-helper';
import { resolveCliTenant } from '../resolve-cli-tenant';
import { serverLogger } from '@/lib/observability/server-logger';

export async function GET(request: Request) {
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

    // Step 3: Query apps with tenant names
    // Join app table with tenant table to get tenant_name (organization_name)
    const { data: apps, error: appsError } = await tenantSupabase
      .from('app')
      .select(`
        id,
        name,
        tenant_id,
        created_at,
        tenant:tenant_id (
          organization_name
        )
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (appsError) {
      console.error('[CLI API] Failed to fetch apps:', appsError.message);
      return NextResponse.json(
        { error: 'Failed to fetch apps' },
        { status: 500 }
      );
    }

    // Step 4: Transform to contract shape
    const transformedApps = (apps || []).map((app) => ({
      id: app.id,
      name: app.name,
      tenant_id: app.tenant_id,
      tenant_name: (app.tenant as { organization_name: string } | null)?.organization_name || '',
      created_at: app.created_at,
    }));

    return NextResponse.json({ apps: transformedApps });

  } catch (error) {
    await serverLogger.error(error as Error, {
      context: '[CLI API] GET /api/cli/apps failed',
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
