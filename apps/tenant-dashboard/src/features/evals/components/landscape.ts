/**
 * Landscape data — the multi-config comparison view.
 *
 * Resolve rate (execution-verified) vs $-PER-RESOLVED-TASK (real outcome
 * cost, not token price), one point per config, each carrying its 95% CI as
 * a confidence ellipse — and the Pareto frontier marked so dominated configs
 * are obvious.
 *
 * Demo data is deterministic; the real view reads one LandscapePoint per
 * config straight from ReportStats (resolveRate + dollarsPerResolved, both
 * already CI-bearing).
 */

export interface LandscapePoint {
  configId: string;
  /** Execution-verified resolve rate [0,1] with its 95% CI. */
  resolveRate: number;
  resolveCi95: [number, number];
  /** $ per RESOLVED task (outcome cost) with its 95% CI. */
  dollarsPerResolved: number;
  dollarCi95: [number, number];
}

/** Sample landscape — five agent configs on one repo. Includes two dominated
 * configs so the Pareto story is legible (sonnet is dominated by codex;
 * opencode by glm/codex). */
export function sampleLandscape(): LandscapePoint[] {
  return [
    { configId: "opus-4.8", resolveRate: 0.64, resolveCi95: [0.55, 0.72], dollarsPerResolved: 0.66, dollarCi95: [0.56, 0.78] },
    { configId: "codex-gpt-5.5", resolveRate: 0.6, resolveCi95: [0.51, 0.68], dollarsPerResolved: 0.24, dollarCi95: [0.19, 0.3] },
    { configId: "sonnet-5", resolveRate: 0.58, resolveCi95: [0.49, 0.66], dollarsPerResolved: 0.28, dollarCi95: [0.22, 0.35] },
    { configId: "glm-5.2", resolveRate: 0.52, resolveCi95: [0.43, 0.61], dollarsPerResolved: 0.13, dollarCi95: [0.1, 0.17] },
    { configId: "opencode-qwen", resolveRate: 0.44, resolveCi95: [0.35, 0.53], dollarsPerResolved: 0.3, dollarCi95: [0.24, 0.38] },
  ];
}

/**
 * Pareto frontier for "maximize resolve rate, minimize $/resolved-task". A
 * point is dominated if another has resolve ≥ AND cost ≤ (strictly better on
 * at least one). Returns the set of config ids ON the frontier.
 */
export function paretoFront(points: LandscapePoint[]): Set<string> {
  const front = new Set<string>();
  for (const p of points) {
    const dominated = points.some(
      (q) =>
        q.configId !== p.configId &&
        q.resolveRate >= p.resolveRate &&
        q.dollarsPerResolved <= p.dollarsPerResolved &&
        (q.resolveRate > p.resolveRate || q.dollarsPerResolved < p.dollarsPerResolved),
    );
    if (!dominated) front.add(p.configId);
  }
  return front;
}
