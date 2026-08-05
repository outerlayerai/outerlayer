import { describe, expect, it } from 'vitest';
import { TOPIC_FACETS, parseTopicFacet } from '../topics-shared';

describe('parseTopicFacet', () => {
  // proves AC-056-02
  it('accepts EVERY canonical facet — a subset here silently unfilters that facet drill-down', () => {
    // Positional over the canonical list: adding a facet to TOPIC_FACETS
    // without it round-tripping through URL parsing fails here, not in prod.
    expect(TOPIC_FACETS.map((facet) => parseTopicFacet(facet))).toEqual([
      'task',
      'issues',
      'steering',
    ]);
  });

  it('rejects unknown, empty, and absent values', () => {
    expect(parseTopicFacet('sentiment')).toBeUndefined();
    expect(parseTopicFacet('TASK')).toBeUndefined();
    expect(parseTopicFacet('')).toBeUndefined();
    expect(parseTopicFacet(null)).toBeUndefined();
    expect(parseTopicFacet(undefined)).toBeUndefined();
  });
});
