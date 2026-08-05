/**
 * CLI Dev Key API Route
 *
 * POST /api/cli/dev-key
 *
 * Creates a scoped dev API key for CLI trace forwarding.
 * Contract:
 * - Auth: Bearer token (Supabase JWT)
 * - Body: { app_id, device_name? }
 * - Creates a Postgres key-store key with prefix sk_outerlayer_dev_, 30-day TTL, scope: traces:write
 * - Response: { key, key_id, app_id, app_name, tenant_id, base_url, expires_at, scope }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createCliSupabaseClient } from '../auth-helper';
import { resolveCliTenant } from '../resolve-cli-tenant';
import { mintApiKey } from '@repo/api-key-service';
import { API_KEY_PEPPER } from '@/config-global.server';
import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { API_URL } from '@/config-global';
import { resolveDefaultEnvironmentId } from '@/lib/environments/resolve-default-environment';
import { serverLogger } from '@/lib/observability/server-logger';

const CreateDevKeySchema = z.object({
  app_id: z.string().uuid('app_id must be a valid UUID'),
  device_name: z.string().max(255).regex(/^[\w\s\-().]+$/, 'Invalid characters in device_name').optional(),
});

export async function POST(request: Request) {
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

    // Step 3: Parse and validate request body
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = CreateDevKeySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid request body' },
        { status: 400 }
      );
    }
    const { app_id, device_name } = parsed.data;

    // Step 4: Verify user has access to this app and fetch org name
    const { data: app, error: appError } = await tenantSupabase
      .from('app')
      .select('id, name, tenant_id')
      .eq('id', app_id)
      .eq('tenant_id', tenantId)
      .single();

    const { data: tenantData } = await tenantSupabase
      .from('tenant')
      .select('organization_name')
      .eq('tenant_id', tenantId)
      .single();

    if (appError || !app) {
      return NextResponse.json(
        { error: 'App not found or access denied' },
        { status: appError?.code === 'PGRST116' ? 404 : 403 }
      );
    }

    // Step 5: Mint a dev key in the Postgres key-store (prefix sk_outerlayer_dev_,
    // 30-day expiry, trace.write scope). mintApiKey inserts the row on the user
    // (bearer) client and writes the digest via the admin client's RPC.
    const keyName = device_name || `CLI Dev Key - ${new Date().toISOString()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const environmentId = await resolveDefaultEnvironmentId(tenantSupabase, app_id);

    // Actor-scoped key: bind the caller's membership so agent sessions
    // synced with this key attribute to the developer's seat (ActorId =
    // membership id — never an email). Best-effort: a missing membership row
    // mints a shared-attribution key rather than failing.
    const { data: membership } = await tenantSupabase
      .from('membership')
      .select('id')
      .eq('user_id', user.id)
      .eq('tenant_id', tenantId)
      .single();

    let plaintext: string;
    let apiKeyId: string;
    try {
      const result = await mintApiKey({
        rowClient: tenantSupabase,
        adminClient: createSupabaseAdminClient(),
        pepper: API_KEY_PEPPER,
        tenantId,
        appId: app_id,
        name: keyName,
        environmentId,
        permissions: ['trace.write'],
        expiresAt: expiresAt.toISOString(),
        actorMembershipId: membership?.id ?? null,
        prefix: 'sk_outerlayer_dev_',
      });
      plaintext = result.plaintext;
      apiKeyId = result.row.api_key_id;
    } catch (err) {
      console.error('[CLI API] Failed to mint dev key:', err);
      return NextResponse.json(
        { error: 'Failed to store API key' },
        { status: 500 }
      );
    }

    // Step 6: Return key details per contract
    return NextResponse.json({
      key: plaintext,
      key_id: apiKeyId,
      app_id: app_id,
      app_name: app.name,
      org_name: tenantData?.organization_name ?? null,
      tenant_id: tenantId,
      base_url: API_URL,
      expires_at: expiresAt.toISOString(),
      scope: 'traces:write',
    }, { status: 201 });

  } catch (error) {
    await serverLogger.error(error as Error, {
      context: '[CLI API] POST /api/cli/dev-key failed',
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
