/**
 * Mock score pool: source distribution.
 *
 * The demo pool must show both write-side score sources — a majority of
 * automated 'experiment' scores with a meaningful minority of human
 * 'annotation' scores — and it must do so at BOTH generation sites (the base
 * trace pool and the complex demo traces), so every demo surface that filters
 * by source has data on each side.
 */

import { getMockDataPool } from '../mock-data';
import type { MockScore } from '../mock-data';

// Complex-trace spans are `span-trace-complex-*`; base-pool spans are
// `span-trace-NNN-gen-G`. Scores attach to spans via resourceId.
const isComplexTraceScore = (s: MockScore) =>
  s.resourceId.startsWith('span-trace-complex-');

function tallySources(scores: MockScore[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of scores) counts[s.source] = (counts[s.source] ?? 0) + 1;
  return counts;
}

describe('mock data pool score sources', () => {
  const pool = getMockDataPool();
  const partitions = [
    ['base trace pool', pool.scores.filter((s) => !isComplexTraceScore(s))],
    ['complex traces', pool.scores.filter(isComplexTraceScore)],
  ] as const;

  it.each(partitions)(
    '%s scores are majority experiment with annotations present',
    (_site, scores) => {
      const counts = tallySources(scores);

      // Only the two write-side sources appear — no legacy 'eval', no typos.
      expect(Object.keys(counts).sort()).toEqual(['annotation', 'experiment']);

      // ~70/30 split: automated experiment scores strictly outnumber human
      // annotations, but annotations genuinely exist (both filter sides have
      // demo data). Guards against the split collapsing to one source or
      // inverting.
      expect(counts['annotation']).toBeGreaterThan(0);
      expect(counts['experiment']).toBeGreaterThan(counts['annotation'] ?? 0);
    },
  );
});
