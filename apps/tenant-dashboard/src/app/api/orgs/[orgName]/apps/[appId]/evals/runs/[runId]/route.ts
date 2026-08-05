/**
 * Poll a single eval run — the benchmarks UI polls this after dispatch until
 * the status is terminal (succeeded/failed), then renders the Report Card.
 *
 * GET /api/orgs/{orgName}/apps/{appId}/evals/runs/{runId}?appId=...  →  { run }
 *
 * A `// live:` surface: it stays a polled endpoint rather than a React Server Component (RSC) read
 * because the run advances in the background (the executor Machine) with no
 * user action to hang a revalidation off of, until it reaches a terminal
 * status.
 *
 * Scoping: `appId` is tenant-validated by `withApi`; the read runs on the
 * request-tenant RLS client, so a foreign appId or a run the tenant can't see
 * 404s rather than leaking another tenant's run. The `[appId]` path
 * segment names the app for the canonical URL; the handler pins it to the
 * `?appId` query `withApi` authorizes.
 */

import 'server-only';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { ValidationError, NotFoundError } from '@repo/observability-service';
import { withApi } from '@/lib/api/with-api';
import { evalsService } from '@/features/evals/service';
import type { ServiceContext } from '@/lib/action-kit/service-context';
import { createSupabaseServerClient } from '@/supabaseServerClient';

const RunQuerySchema = z.object({ appId: z.string().min(1) });
const RunParamsSchema = z.object({
  orgName: z.string().min(1),
  appId: z.string().min(1),
  runId: z.string().min(1),
});

export const GET = withApi(
  {
    method: 'get',
    path: '/api/orgs/{orgName}/apps/{appId}/evals/runs/{runId}',
    tags: ['Evals'],
    summary: 'Poll a single eval run',
    operationId: 'evals-run-get',
    description:
      'Returns `{ run }` for a single eval run — the benchmarks UI polls this after dispatch until the status is terminal.',
    request: { query: RunQuerySchema, params: RunParamsSchema },
    responses: {
      200: { description: '`{ run }` — the eval run row including its Report Card.' },
      400: { description: 'Invalid query params.' },
      401: { description: 'Not authenticated.' },
      404: { description: 'Run not found.' },
    },
    remapNotFound: 'eval_run_not_found',
  },
  async ({ context, input }) => {
    // Constraint: `withApi` authenticates appId from the QUERY STRING only, so
    // the `?appId` query is the value `verifyAppAccess` authorizes; the
    // `[appId]` path segment is the canonical URL's copy. Pin them equal so the
    // URL can never name a different app than the one actually authorized.
    if (input.params.appId !== input.query.appId) {
      throw new ValidationError('appId path segment and query must match');
    }

    // The `eval_run` read is member-readable under RLS, so this runs on the
    // request-tenant client (no elevation): the verified `context.tenantId`
    // scopes `public.tenant_id()`, and a foreign run reads as absent.
    const supabase = await createSupabaseServerClient(context.tenantId);
    const svcCtx: ServiceContext = {
      db: supabase,
      tenantId: context.tenantId,
      actor: { userId: context.userId, role: '' },
    };

    const run = await evalsService.get(svcCtx, context.appId, input.params.runId);
    if (!run) throw new NotFoundError('Run not found.');
    return NextResponse.json({ run });
  },
);
