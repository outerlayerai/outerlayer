/**
 * Zod schema for the `generateTopics` server action's input.
 *
 * No `environment` field: the dashboard is currently pinned to each app's
 * default environment everywhere (EnvContext's default-env-only posture —
 * the `/env/<name>/` URL segment is not a user choice today), so the
 * environment is resolved server-side rather than accepted from the client.
 */

import { z } from 'zod';
import { TOPIC_FACETS } from '@/lib/analytics/topics/topics-shared';

export const generateTopicsInput = z.object({
  appId: z.string().min(1),
  facet: z.enum(TOPIC_FACETS).default('task'),
});
