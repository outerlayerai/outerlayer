/**
 * Dashboards privacy constraint tests.
 *
 * Product decision: OuterLayer dashboards must never rank or aggregate
 * individual developers/actors, gated or not. This file is the automated check
 * that decision asked for: a future PR that adds an actor/developer
 * groupBy or metric fails HERE, not in code review.
 *
 * Each assertion is a snapshot of the CURRENT allow-list, not a substring
 * search — a substring check would miss a field named e.g. `assignee` or
 * `member_id` that means the same thing without matching "actor"/"developer".
 */

vi.mock('server-only', () => ({}));

import {
  PROMOTED_FILTER_FIELDS,
  BUILT_IN_METRICS,
  METRIC_LABELS,
  STAT_ONLY_METRICS,
  AGENT_FLEET_METRICS,
  AGENT_FLEET_TILE_METRICS,
  AGENT_PR_METRICS,
  AGENT_FLEET_DIMENSION_METRICS,
  AGENT_FLEET_ANOMALY_METRICS,
  AGENT_FLEET_TREND_METRICS,
  agentFleetDimensionFor,
} from './types';
import { createWidgetSchema } from './validation';
import { CreateWidgetBodySchema } from './schemas';

// A widget's groupBy is the mechanism a per-actor breakdown would use.
// Any of these strings appearing as an allowed groupBy/filter field would
// mean "who did this" has become a selectable dashboard dimension.
const FORBIDDEN_IDENTITY_TERMS = ['actor', 'developer', 'assignee', 'member', 'employee', 'author'];

describe('dashboards privacy constraint', () => {
  it('promoted filter/groupBy fields are exactly the current allow-list — no identity field added', () => {
    // Positional equality, not "contains" — a reorder or an addition both fail loudly.
    expect(PROMOTED_FILTER_FIELDS).toEqual(['model', 'user_id', 'status']);
  });

  it('no promoted filter field name matches a per-person identity term', () => {
    for (const field of PROMOTED_FILTER_FIELDS) {
      for (const term of FORBIDDEN_IDENTITY_TERMS) {
        expect(field.toLowerCase()).not.toContain(term);
      }
    }
  });

  it('no BuiltInMetric id or label matches a per-person identity term, except the two sanctioned COUNT metrics', () => {
    // active_actor_count (a stat) and active_actor_trend (its daily-count
    // trend counterpart, covered by its own privacy test below) are the
    // deliberate exceptions — both are bare counts, never a per-actor
    // breakdown. Everything else must stay clean.
    const SANCTIONED_EXCEPTIONS = new Set(['active_actor_count', 'active_actor_trend']);
    for (const metric of BUILT_IN_METRICS) {
      if (SANCTIONED_EXCEPTIONS.has(metric)) continue;
      for (const term of FORBIDDEN_IDENTITY_TERMS) {
        expect(metric.toLowerCase()).not.toContain(term);
        expect((METRIC_LABELS[metric] ?? '').toLowerCase()).not.toContain(term);
      }
    }
  });

  it('active_actor_count is a stat-only metric — it can never be rendered as a ranking/bar/line', () => {
    expect(STAT_ONLY_METRICS).toContain('active_actor_count');
  });

  it('all Agent Fleet Overview tile metrics are stat-only', () => {
    // session_count and tool_error_rate are stat-only too (no
    // time-series query for them yet) — belt-and-suspenders with the
    // dedicated privacy rationale for active_actor_count specifically.
    // Derived from the exported constant (not a hand-typed literal) so this
    // test fails if a future tile metric is added without also adding it here.
    for (const metric of AGENT_FLEET_TILE_METRICS) {
      expect(STAT_ONLY_METRICS).toContain(metric);
    }
  });

  it('the non-stat-only agent-fleet metrics are exactly the ranking/trend ones — pin the set so a future metric can\'t land in neither bucket', () => {
    // Every metric NOT in STAT_ONLY_METRICS renders as either a ranking
    // (model mix, the dimension breakdowns, the cost-anomaly ranking) or a
    // time-series trend (the four AGENT_FLEET_TREND_METRICS) regardless of
    // the widget's stored visualization.
    const nonStatOnly = AGENT_FLEET_METRICS.filter((m) => !STAT_ONLY_METRICS.includes(m));
    expect(nonStatOnly.sort()).toEqual(
      [
        'agent_model_mix',
        'agent_cost_by_branch',
        'agent_sessions_by_branch',
        'agent_tool_error_rate_by_branch',
        'agent_cost_by_agent_type',
        'agent_sessions_by_agent_type',
        'agent_cost_by_worker_kind',
        'agent_sessions_by_worker_kind',
        ...AGENT_FLEET_ANOMALY_METRICS,
        ...AGENT_FLEET_TREND_METRICS,
      ].sort(),
    );
  });

  it('dimension metrics only resolve to branch, agent_type, or worker_kind — never an actor dimension', () => {
    // agentFleetDimensionFor is the one place a metric ID turns into the SQL
    // groupBy column (DIMENSION_COLUMNS in queries-agent-fleet.ts) — pin
    // every dimension metric to one of the three sanctioned WORK-SHAPED
    // dimensions. worker_kind is run-origin (seat|cloud|ci|shared — where a
    // session ran), which is deliberately allowed; who ran it is not.
    for (const metric of AGENT_FLEET_DIMENSION_METRICS) {
      expect(['branch', 'agent_type', 'worker_kind']).toContain(agentFleetDimensionFor(metric));
    }
    expect(agentFleetDimensionFor('agent_sessions_by_worker_kind')).toBe('worker_kind');
    expect(agentFleetDimensionFor('agent_cost_by_worker_kind')).toBe('worker_kind');
    // A metric outside the dimension set (or a hypothetical 'actor'/'developer'
    // metric someone pastes in later) must resolve to null, not silently
    // fall through to a dimension.
    expect(agentFleetDimensionFor('active_actor_count')).toBeNull();
    expect(agentFleetDimensionFor('agent_cost_by_actor')).toBeNull();
    expect(agentFleetDimensionFor('agent_sessions_by_developer')).toBeNull();
  });

  it('spend-per-active-dev is an aggregate ratio tile: stat-only, and never a dimension', () => {
    // The ratio's denominator is the bare uniqExact actor COUNT — the metric
    // must never become a per-actor breakdown (ranking/bar/line) or resolve
    // to a groupBy dimension.
    expect(STAT_ONLY_METRICS).toContain('agent_spend_per_active_dev');
    expect(agentFleetDimensionFor('agent_spend_per_active_dev')).toBeNull();
  });

  it('no Agent Execution Health trend metric is stat-only — a blended snapshot is exactly what these exist to avoid', () => {
    // Inverse of the tile-metrics test above: trend metrics must NEVER be
    // stat-only, since collapsing a percentile trend to one number for the
    // date range is the specific mistake this whole metric group corrects.
    for (const metric of AGENT_FLEET_TREND_METRICS) {
      expect(STAT_ONLY_METRICS).not.toContain(metric);
    }
  });

  it('PR-lifecycle metrics carry no identity dimension: merge rate is stat-only, cycle time is trend-only, and neither resolves to a groupBy', () => {
    // The PR metrics aggregate over PRs, never over the people who reviewed
    // or authored them — there is no reviewer/author field anywhere in the
    // pipeline (see pr-metrics.ts: rows carry pr_number/branch/state/times
    // only). Pin the rendering shapes and that neither metric can reach the
    // dimension-groupBy path.
    expect(STAT_ONLY_METRICS).toContain('agent_pr_merge_rate');
    expect(STAT_ONLY_METRICS).not.toContain('agent_pr_cycle_time_trend');
    expect(agentFleetDimensionFor('agent_pr_merge_rate')).toBeNull();
    expect(agentFleetDimensionFor('agent_pr_cycle_time_trend')).toBeNull();
    // And a hypothetical per-person PR metric must not slip into the set.
    for (const metric of AGENT_PR_METRICS) {
      for (const term of FORBIDDEN_IDENTITY_TERMS) {
        expect(metric.toLowerCase()).not.toContain(term);
      }
    }
  });

  it('REJECTS creating a widget that pairs active_actor_count with a non-stat visualization (validation.ts)', () => {
    const result = createWidgetSchema.safeParse({
      title: 'Actors by day',
      metric: 'active_actor_count',
      visualization: 'bar',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('visualization'))).toBe(true);
    }
  });

  it('REJECTS the same combination on the withApi schema (zod-schemas.ts)', () => {
    const result = CreateWidgetBodySchema.safeParse({
      title: 'Actors by day',
      metric: 'active_actor_count',
      visualization: 'line',
    });
    expect(result.success).toBe(false);
  });

  it('ACCEPTS active_actor_count paired with stat (the only valid combination)', () => {
    const result = createWidgetSchema.safeParse({
      title: 'Active Actors',
      metric: 'active_actor_count',
      visualization: 'stat',
    });
    expect(result.success).toBe(true);
  });
});
