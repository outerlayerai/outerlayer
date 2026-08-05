import 'server-only';
import {
  ForbiddenError,
  ServiceUnavailableError,
} from '@repo/observability-service';
import { loadRequestServiceContext } from '@/lib/adapters';
import { createTenantReadClient } from '@/lib/analytics/client';
import { DEFAULT_ENV_NAME } from '@/lib/environments/default-env-name';
import { checkAppPermission } from '@/utils/permission-check';
import { Permissions } from '@/utils/permissions';
import { buildTopicsService } from './service';
import type { TopicFacet, TopicsList } from '@/lib/analytics/topics/topics-shared';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The React Server Component (RSC) read behind the Topics card: the active topic map for one app under
 * the request tenant + facet. Mirrors the deleted GET route's shape —
 * `trace.read` gates the read, and the steering facet gets the tenant's
 * capture-tier ceiling for its empty-tab explainer.
 *
 * Scoped to the app's default environment: the dashboard is currently pinned
 * to it everywhere (EnvContext's default-env-only posture), so there is no
 * environment to accept from the caller yet.
 *
 * Throws `ForbiddenError` / `ServiceUnavailableError` on the same conditions
 * the route did; the page catches them and renders the equivalent error state.
 */
export async function loadTopicsForApp(
  appId: string,
  facet: TopicFacet,
): Promise<TopicsList> {
  const { error: permError } = await checkAppPermission(
    Permissions.TRACE_READ,
    appId,
  );
  if (permError) throw new ForbiddenError(permError);

  const ctx = await loadRequestServiceContext();

  // Row-policy-scoped read: tenant + app pinned from the resolved auth
  // context — ClickHouse enforces the tenant boundary.
  const client = createTenantReadClient({ tenantId: ctx.tenantId, appId });
  if (!client) {
    throw new ServiceUnavailableError(
      'Analytics not available — ClickHouse is not configured.',
    );
  }

  const service = buildTopicsService(client);

  const list = await service.listTopics(
    {
      tenantId: ctx.tenantId,
      appId,
      environment: DEFAULT_ENV_NAME,
      environmentIsDefault: true,
    },
    facet,
  );

  // Steering mines full-tier message text; a tenant below `full` never gets
  // steering rows, so the page needs the tier to explain the empty tab
  // instead of showing nothing. Only the steering facet depends on it — the
  // other facets skip the extra read. Read through the request-scoped client
  // (RLS already lets a member read their own tenant row — the "Users can
  // read tenant" policy's active-membership clause needs no permission grant)
  // rather than the admin client the deleted route used.
  if (facet === 'steering') {
    const db = ctx.db as SupabaseClient;
    const { data } = await db
      .from('tenant')
      .select('agent_capture_tier')
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle();
    const tier = (data as { agent_capture_tier?: unknown } | null)
      ?.agent_capture_tier;
    return {
      ...list,
      captureTier:
        tier === 'metrics' || tier === 'redacted' || tier === 'full'
          ? tier
          : 'full',
    };
  }

  return list;
}
