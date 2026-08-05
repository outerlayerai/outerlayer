/**
 * Dashboard Templates
 *
 * Pre-built dashboard templates as TypeScript constants.
 * Version-controlled, type-safe, no database migration needed to add new ones.
 *
 * The gallery is deliberately THREE templates, one per recurring decision:
 *
 *   1. Agent Outcomes — "is it working?" The auto-created default and the
 *      trust board: evidence-grade signals only.
 *   2. Cost & Impact — "is it worth it?" The leadership board: every number
 *      is a dollar or a comparison.
 *   3. Agent Operations — "where is it breaking?" The debug board: every
 *      tile points at a place or a behavior someone can go fix.
 *
 * Two editorial rules keep the set coherent:
 *  - Bounded overlap: a metric appears on at most two boards, and the second
 *    appearance must be as the guardrail for that board's headline (Clean Job
 *    Rate guards outcomes on the trust board and autonomy on Cost & Impact).
 *  - Evidence first: templates prefer metrics with a `METRIC_EVIDENCE` tier
 *    of provider-record or metered; session-derived metrics appear where the
 *    operational job demands them, with their tier disclosed on the tile.
 *
 * Retired as pre-built templates (their metrics stay available in the widget
 * config dialog, just not as starting cards): the 25-widget Executive
 * Overview (trimmed into Cost & Impact — a board nobody scrolled to the end
 * of is not an executive summary); Agent Fleet Overview (a six-tile subset
 * of the Executive board with no distinct job — its trust tiles live on
 * Agent Outcomes, its spend tile on Cost & Impact); Agent Execution Health
 * (absorbed whole into Agent Operations); the raw-LLM-call
 * Request/Cost/Performance re-cuts; the generic Score Analytics re-cut; the
 * standalone Agent Autonomy board; and Repo Activity (analytical/situational,
 * not a day-one default).
 */

import type {
  TemplateDefinition,
  DashboardTemplate,
} from './types';

// ============================================================================
// Template Definitions
// ============================================================================

/**
 * Agent Outcomes — "is it working?" The auto-created default.
 *
 * Evidence-grade only: PR-outcome scores computed per agent session
 * (first-pass CI verdict, merge fate, revert durability) next to the same
 * rates from the Postgres PR-lifecycle record,
 * with Clean Job Rate as the session-grain floor. The score/lifecycle
 * pairing is the point: scores are session-grain (a PR with three
 * contributing sessions counts three times), lifecycle tiles are PR-grain —
 * when the two disagree, that gap is signal (multi-session PRs, unlinked
 * sessions), not noise.
 *
 * The per-name summary leads because it lists EVERY score name present — as
 * new per-run signals start landing in the scores table (assertions, judge
 * verdicts, human labels), they appear on this board with no template
 * change. Outcome scores bucket by PR-open cohort (CreatedAt anchors to
 * opened_at), so a date range reads as "PRs opened in this window."
 *
 * Closes with the one score-outcome correlation that has a real
 * predictor to point at today: merge rate split by whether first-pass CI
 * passed. `worker.merged`/`worker.reverted` are fate-derived and banned from
 * that predictor axis (see FATE_DERIVED_SCORE_NAMES); `worker.ci_green` is
 * decided before the merge, so it qualifies. Assertion/judge/human-verdict
 * scores will get their own correlation widgets here once a writer for them
 * exists; hardcoding an empty scoreName now would ship a permanently-empty
 * tile.
 */
const agentOutcomesTemplate: TemplateDefinition = {
  id: 'agent-outcomes',
  name: 'Agent Outcomes',
  description:
    'Is it working? Ground-truth outcome scores per agent session — first-pass CI, merge fate, revert durability — cross-checked against the PR-lifecycle rates',
  widgets: [
    // Every score name present, with its true-rate — future per-run signals
    // (assertions, judges) join this list automatically.
    { title: 'Outcome Scores by Name', metric: 'score_summary', visualization: 'stat' },
    { title: 'First-Pass CI Green Rate', metric: 'score_trend', visualization: 'line', scoreName: 'worker.ci_green' },
    { title: 'Merge Outcome Split', metric: 'score_histogram', visualization: 'bar', scoreName: 'worker.merged' },
    { title: 'Revert Rate Trend', metric: 'score_trend', visualization: 'line', scoreName: 'worker.reverted' },
    // The PR-grain cross-check for the session-grain scores above…
    { title: 'Agent PR Merge Rate (lifecycle)', metric: 'agent_pr_merge_rate', visualization: 'stat' },
    { title: 'Revert Rate (lifecycle)', metric: 'agent_pr_revert_rate', visualization: 'stat' },
    // …and the session-grain floor guarding both.
    { title: 'Clean Job Rate', metric: 'agent_clean_job_rate', visualization: 'stat' },
    // The one real correlation predictor today — see the header comment.
    // A single lift stat (pass-minus-fail), not a bar chart — see
    // STAT_ONLY_METRICS in types.ts for why.
    {
      title: 'Merge Rate by First-Pass CI',
      metric: 'agent_pr_outcome_by_score_merge_rate',
      visualization: 'stat',
      scoreName: 'worker.ci_green',
    },
  ],
  layout: [
    // Row 1 — the score board + the CI trend
    { widgetId: '', x: 0, y: 0, w: 6, h: 4 },
    { widgetId: '', x: 6, y: 0, w: 6, h: 4 },
    // Row 2 — merge split + revert trend
    { widgetId: '', x: 0, y: 4, w: 6, h: 4 },
    { widgetId: '', x: 6, y: 4, w: 6, h: 4 },
    // Row 3 — lifecycle cross-checks, the clean-job floor, and the
    // correlation close — a single-number stat, same footprint as its
    // row-mates, not the wider bar-chart footprint a two-item ranking needed.
    { widgetId: '', x: 0, y: 8, w: 4, h: 2 },
    { widgetId: '', x: 4, y: 8, w: 4, h: 2 },
    { widgetId: '', x: 8, y: 8, w: 4, h: 2 },
    { widgetId: '', x: 0, y: 10, w: 4, h: 2 },
  ],
};

/**
 * Cost & Impact — "is it worth it?" The leadership board.
 *
 * Every number is a dollar or a comparison: "worth it" claims need a
 * denominator (cost per merged PR, per resolved task, per active dev) and a
 * control group (the agent-vs-human bars — same repo, same period; a
 * comparison, not a controlled experiment, and each tile's description says
 * so). The verified-eval tile sits beside the observational cost tiles as
 * the controlled-experiment complement.
 *
 * The autonomy headline closes the board — shipped work by autonomy level,
 * guarded by Clean Job Rate directly beneath it (autonomy growth is only
 * good news if quality holds; the guardrail pairing is the design rule).
 */
const costImpactTemplate: TemplateDefinition = {
  id: 'cost-impact',
  name: 'Cost & Impact',
  description:
    'Is it worth it? Cost per merged PR, total spend, agent-vs-human comparisons, and the autonomy trend — every number a dollar or a comparison',
  widgets: [
    // The dollars row: the ROI unit, the whole-program figure, the per-head ratio.
    { title: 'Cost per Merged PR', metric: 'agent_cost_per_merged_pr', visualization: 'stat' },
    { title: 'Total Cost of AI', metric: 'total_cost_of_ai', visualization: 'stat' },
    { title: 'Spend per Active Dev', metric: 'agent_spend_per_active_dev', visualization: 'stat' },
    // The waste lever + the controlled-experiment complement.
    { title: 'Unshipped Spend', metric: 'agent_unshipped_spend_share', visualization: 'stat' },
    { title: 'Cost per Resolved Task (Latest Benchmark)', metric: 'agent_cost_per_resolved_task', visualization: 'stat' },
    { title: 'Agent Share of Merged PRs', metric: 'agent_share_of_merged_prs', visualization: 'stat' },
    // "Compared to what?" — the within-org control group.
    { title: 'Cycle Time: Agent vs Human', metric: 'agent_vs_human_cycle_time', visualization: 'bar' },
    { title: 'First-Pass CI: Agent vs Human', metric: 'agent_vs_human_first_pass_ci', visualization: 'bar' },
    { title: 'PR Size: Agent vs Human', metric: 'agent_vs_human_pr_size', visualization: 'bar' },
    // The category headline, guarded by the quality floor beneath it.
    { title: 'Shipped Work by Autonomy Level', metric: 'agent_shipped_autonomy_trend', visualization: 'area' },
    { title: 'Clean Job Rate', metric: 'agent_clean_job_rate', visualization: 'stat' },
  ],
  layout: [
    // Row 1 — dollars
    { widgetId: '', x: 0, y: 0, w: 4, h: 2 },
    { widgetId: '', x: 4, y: 0, w: 4, h: 2 },
    { widgetId: '', x: 8, y: 0, w: 4, h: 2 },
    // Row 2 — waste, verified complement, coverage
    { widgetId: '', x: 0, y: 2, w: 4, h: 2 },
    { widgetId: '', x: 4, y: 2, w: 4, h: 2 },
    { widgetId: '', x: 8, y: 2, w: 4, h: 2 },
    // Row 3 — the agent-vs-human comparison bars
    { widgetId: '', x: 0, y: 4, w: 4, h: 3 },
    { widgetId: '', x: 4, y: 4, w: 4, h: 3 },
    { widgetId: '', x: 8, y: 4, w: 4, h: 3 },
    // Row 4 — the autonomy headline with its guardrail beside it
    { widgetId: '', x: 0, y: 7, w: 8, h: 4 },
    { widgetId: '', x: 8, y: 7, w: 4, h: 2 },
  ],
};

/**
 * Agent Operations — "where is it breaking?" The debug board.
 *
 * Every tile points at a place or a behavior someone can go fix: the
 * fleet-wide reliability floors, the by-branch cuts that turn a rate into
 * "which work is failing," the babysitting load (steering + hands-on), and
 * the run-shape trends whose tail spikes flag runaway sessions. Dimension
 * cuts are work-shaped (branch), never per-developer. Outcome and
 * durability live on Agent Outcomes — this board stays process-only so a
 * red tile here always means "go look at the machinery," not "the work was
 * bad."
 */
const agentOperationsTemplate: TemplateDefinition = {
  id: 'agent-operations',
  name: 'Agent Operations',
  description:
    'Where is it breaking? Reliability floors, where errors and cost anomalies cluster by branch, babysitting load, and run-shape trends',
  widgets: [
    { title: 'Tool Error Rate', metric: 'tool_error_rate', visualization: 'stat' },
    { title: 'Clean Session Rate', metric: 'clean_session_rate', visualization: 'stat' },
    { title: 'Hands-On Rate', metric: 'agent_hands_on_rate', visualization: 'stat' },
    // Merge-gate integrity: a process floor, not an output-quality claim.
    { title: 'Unreviewed Merge Rate', metric: 'agent_pr_unreviewed_merge_rate', visualization: 'stat' },
    // Where the problems concentrate — work-shaped dimensions only.
    { title: 'Tool Error Rate by Branch', metric: 'agent_tool_error_rate_by_branch', visualization: 'bar' },
    { title: 'Cost Anomalies by Branch', metric: 'agent_cost_anomalies_by_branch', visualization: 'bar' },
    // How sessions RAN, trended — error / denial / hands-on rates in one
    // chart, so drift in trajectory quality is visible before it lands in
    // outcomes.
    { title: 'Trajectory Signals', metric: 'agent_trajectory_signals_trend', visualization: 'line' },
    // Run-shape trends: daily percentiles, never one blended number.
    { title: 'Follow-ups per Session', metric: 'agent_interventions_trend', visualization: 'line' },
    { title: 'Session Duration Trend', metric: 'agent_session_duration_trend', visualization: 'line' },
    { title: 'Turn Count Trend', metric: 'agent_turn_count_trend', visualization: 'line' },
  ],
  layout: [
    // Row 1 — the four floors
    { widgetId: '', x: 0, y: 0, w: 3, h: 2 },
    { widgetId: '', x: 3, y: 0, w: 3, h: 2 },
    { widgetId: '', x: 6, y: 0, w: 3, h: 2 },
    { widgetId: '', x: 9, y: 0, w: 3, h: 2 },
    // Row 2 — the by-branch cuts
    { widgetId: '', x: 0, y: 2, w: 6, h: 4 },
    { widgetId: '', x: 6, y: 2, w: 6, h: 4 },
    // Row 3 — trajectory signals beside the steering-depth trend
    { widgetId: '', x: 0, y: 6, w: 6, h: 4 },
    { widgetId: '', x: 6, y: 6, w: 6, h: 4 },
    // Row 4 — the run-shape trends
    { widgetId: '', x: 0, y: 10, w: 6, h: 4 },
    { widgetId: '', x: 6, y: 10, w: 6, h: 4 },
  ],
};

// ============================================================================
// Public API
// ============================================================================

export const TEMPLATES: TemplateDefinition[] = [
  agentOutcomesTemplate,
  costImpactTemplate,
  agentOperationsTemplate,
];

/** Default template ID used when auto-creating a dashboard. The trust board
 * leads: a first-run user should meet a small set of evidence-grade numbers,
 * not a wall of charts. */
export const DEFAULT_TEMPLATE_ID = 'agent-outcomes';

export function getTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function getTemplateList(): DashboardTemplate[] {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    widgetCount: t.widgets.length,
    widgets: t.widgets.map((w) => ({
      title: w.title,
      metric: w.metric,
      visualization: w.visualization ?? 'line',
    })),
  }));
}
