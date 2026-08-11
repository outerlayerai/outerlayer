/**
 * Context OpenAPI Route
 *
 * `GET /v1/context/changes` — the synced-commit history of the app's
 * `.outerlayer/` tree (`public.context_snapshot`), newest first.
 *
 * Snapshot identity is decoupled from commit sha: a push whose compare
 * touches no context files reuses the previous snapshot, so this list is
 * "commits that changed context", not every push. Per-snapshot changed-path
 * detail is not returned here — see the module-level note in this file's
 * test for why (query cost vs. the two-timestamp shape this ships instead).
 */

import { ContextChangesQuerySchema, ContextChangesResponseSchema } from '@repo/api-schemas';
import type { ContextChangesQuery } from '@repo/api-schemas';
import { BaseRoute, type AppContext, errorResponse, getScopedSupabase, structuredError } from './_shared';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

interface ContextSnapshotRow {
  id: string;
  commit_sha: string;
  classifier_version: number;
  created_at: string;
}

/**
 * Shared by the REST handler and the `list_context_changes` MCP tool — one
 * query, so the two surfaces can never answer differently for the same
 * caller + params.
 *
 * Errors propagate (never swallowed into an empty page): a genuine Supabase
 * failure must surface as a 500, not as an indistinguishable "no context
 * synced yet".
 */
export async function listContextChanges(c: AppContext, query: ContextChangesQuery) {
  const user = c.get('user');
  const supabase = await getScopedSupabase(c);
  const { limit, offset } = query;

  const { data, error, count } = await supabase
    .from('context_snapshot')
    .select('id, commit_sha, classifier_version, created_at', { count: 'exact' })
    .eq('app_id', String(user.appId))
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`context_snapshot list failed: ${error.message}`);
  }

  const rows = (data ?? []) as ContextSnapshotRow[];
  return {
    snapshots: rows.map((row) => ({
      id: row.id,
      commitSha: row.commit_sha,
      classifierVersion: row.classifier_version,
      createdAt: row.created_at,
    })),
    pagination: { total: count ?? 0, limit, offset },
  };
}

export class ListContextChanges extends BaseRoute {
  static requiredPermission: GatewayPermission = 'metrics.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Context'],
    summary: 'List context changes',
    operationId: 'list-context-changes',
    description:
      'Returns the synced-commit history of the app\'s `.outerlayer/` context tree, newest first. ' +
      'A new entry appears only for a commit whose context files actually changed — a push that ' +
      'touched no context files advances the branch head without adding a row here.\n\n' +
      'Pair with `GET /v1/metrics/compare` (or two `get_fleet_overview` calls) using the timestamps on ' +
      'either side of a change to see its before/after effect.',
    request: {
      query: ContextChangesQuerySchema,
    },
    responses: {
      200: {
        description: 'A page of context-changing commits.',
        content: {
          'application/json': {
            schema: ContextChangesResponseSchema,
          },
        },
      },
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const query = data.query as ContextChangesQuery;

    try {
      const result = await listContextChanges(c, query);
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      return c.json(structuredError('internal_error', 'Failed to list context changes'), 500);
    }
  }
}
