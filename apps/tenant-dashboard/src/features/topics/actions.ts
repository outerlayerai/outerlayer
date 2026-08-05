'use server';

import { revalidatePath } from 'next/cache';
import { authorizedAction } from '@/lib/action-kit';
import { isTempAccessReadOnlySession } from '@/lib/adapters';
import { getDefaultClient } from '@/lib/analytics/client';
import { DEFAULT_ENV_NAME } from '@/lib/environments/default-env-name';
import { buildTopicsService } from './service';
import { generateTopicsInput } from './schemas';

/** The insights route that renders the Topics card; re-seeded after a generation. */
const INSIGHTS_PATH = '/orgs/[orgName]/apps/[appName]/env/[envName]/insights';

/**
 * Runs Stage 4 topic generation for an app + facet. `trace.read` gates the
 * read of source data; generation also *writes* a new map version plus facet
 * re-assignments in ClickHouse, so a read-only temporary-access grant (RLS
 * keeps its read-only promise only for Postgres, not ClickHouse) is refused
 * here explicitly even though it satisfies `trace.read`. The write runs under
 * the writer identity (`getDefaultClient`) — `analytics_readonly` holds
 * SELECT-only grants and would reject the inserts; the tenant boundary comes
 * from the verified-context `tenantId`/`appId`, never client input.
 *
 * Long-running by nature (clustering seconds at current scale) — the
 * `insights` page carries `export const maxDuration = 300` so this action
 * inherits the same budget (Server Actions inherit the invoking page's
 * `maxDuration`).
 */
export const generateTopics = authorizedAction({
  input: generateTopicsInput,
  permission: 'trace.read',
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    if (await isTempAccessReadOnlySession(ctx.actor.userId, ctx.tenantId)) {
      throw new Error('Temporary access is read-only and cannot generate topics.');
    }

    const client = getDefaultClient();
    if (!client) {
      throw new Error('Analytics not available — ClickHouse is not configured.');
    }

    const service = buildTopicsService(client);
    const outcome = await service.generateTopics(
      {
        tenantId: ctx.tenantId,
        appId: input.appId,
        environment: DEFAULT_ENV_NAME,
        environmentIsDefault: true,
      },
      input.facet,
    );

    revalidatePath(INSIGHTS_PATH, 'page');
    return outcome;
  },
});
