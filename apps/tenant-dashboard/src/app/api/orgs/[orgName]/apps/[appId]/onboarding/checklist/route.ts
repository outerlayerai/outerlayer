/**
 * Onboarding checklist status — drives the getting-started checklist.
 *
 * GET /api/orgs/{orgName}/apps/{appId}/onboarding/checklist?appId=...
 *
 * A `// live:` surface: it stays a polled endpoint rather than a React Server Component (RSC) read
 * because a background tab completes the step (git-connect / deploy) and the
 * client re-polls this endpoint on window refocus.
 *
 * Returns `OnboardingSetupState`: the checklist booleans (`hasApiKey`,
 * `hasTrace`, `hasTeammate`, `hasGitConnection`, `hasRepoLinked`) plus the
 * connected `provider` — one endpoint drives the checklist, the setup card's
 * repo gate, and the soft banner. "Create your first app" is implicit (you can only reach this route
 * from inside an app), so it isn't returned. The signals are gathered in
 * `@/features/onboarding/service` (each one degrades to 0/null on its own
 * failure so a single broken query can't collapse the whole checklist), then
 * turned into booleans by the pure `interpretChecklistCounts` helper.
 *
 * Scoping: API keys and traces are app-scoped; members are tenant-scoped — see
 * `gatherOnboardingSignals`. The `[appId]` path segment names the app for the
 * canonical tenant-scoped URL; `withApi` authorizes the `?appId` query, and the
 * handler pins the two to the same value.
 */

import 'server-only';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { ValidationError } from '@repo/observability-service';
import { withApi } from '@/lib/api/with-api';
import {
  interpretChecklistCounts,
  type OnboardingSetupState,
} from '@/features/onboarding/checklist';
import { gatherOnboardingSignals } from '@/features/onboarding/service';

const ChecklistQuerySchema = z.object({ appId: z.string().min(1) });
const OnboardingParamsSchema = z.object({
  orgName: z.string().min(1),
  appId: z.string().min(1),
});

export const GET = withApi(
  {
    method: 'get',
    path: '/api/orgs/{orgName}/apps/{appId}/onboarding/checklist',
    tags: ['Onboarding'],
    summary: 'Getting-started checklist status',
    operationId: 'onboarding-checklist',
    description:
      'Returns the onboarding setup state (checklist booleans + git provider) — drives the getting-started checklist, the setup card gate, and the soft banner.',
    request: { query: ChecklistQuerySchema, params: OnboardingParamsSchema },
    responses: {
      200: {
        description:
          '`{ hasApiKey, hasTrace, hasTeammate, hasGitConnection, hasRepoLinked, provider }`.',
      },
      400: { description: 'Invalid query params.' },
      401: { description: 'Not authenticated.' },
    },
  },
  async ({ context, input }) => {
    // Constraint: `withApi` authenticates appId from the QUERY STRING only, so
    // the `?appId` query is the value `verifyAppAccess` authorizes; the
    // `[appId]` path segment is the canonical URL's copy. Pin them equal so the
    // URL can never name a different app than the one actually authorized.
    if (input.params.appId !== input.query.appId) {
      throw new ValidationError('appId path segment and query must match');
    }

    const signals = await gatherOnboardingSignals(context);
    const status = interpretChecklistCounts(signals);

    const body: OnboardingSetupState = {
      ...status,
      provider: signals.gitProvider,
    };
    return NextResponse.json(body);
  },
);
