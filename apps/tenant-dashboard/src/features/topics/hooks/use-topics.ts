'use client';

/**
 * useGenerateTopics — the generate/regenerate action wiring for the Topics
 * card. The topic map itself is read by a React Server Component (RSC) and
 * seeded into the card as a
 * prop); this hook owns only the ephemeral UI state around triggering a
 * generation: whether one is in flight and the last outcome it returned.
 * `revalidatePath` inside the `generateTopics` action re-seeds the RSC read
 * on success — no client-side mutate/refetch here.
 */

import { useCallback, useState } from 'react';
import { generateTopics } from '../actions';
import type { GenerateOutcome, TopicFacet } from '@/lib/analytics/topics/topics-shared';

export function useGenerateTopics(appId: string, facet: TopicFacet) {
  const [generating, setGenerating] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<GenerateOutcome | null>(null);

  const generate = useCallback(async (): Promise<GenerateOutcome> => {
    setGenerating(true);
    try {
      const result = await generateTopics({ appId, facet });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setLastOutcome(result.data);
      return result.data;
    } finally {
      setGenerating(false);
    }
  }, [appId, facet]);

  return { generating, lastOutcome, generate };
}
