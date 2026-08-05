/**
 * Unit Tests for Dashboard Templates
 *
 * Tests for template retrieval, structure, and data integrity.
 */

vi.mock('server-only', () => ({}));

import {
  getTemplateList,
  getTemplate,
  TEMPLATES,
  DEFAULT_TEMPLATE_ID,
} from './templates';
import {
  VISUALIZATION_TYPES,
  ALL_METRIC_IDS,
  getMetricEvidenceLine,
} from './types';

// ============================================================================
// getTemplateList
// ============================================================================

describe('getTemplateList', () => {
  it('should return an array of template summaries when called', () => {
    const list = getTemplateList();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it('should return the same number of templates as TEMPLATES constant when compared', () => {
    const list = getTemplateList();
    expect(list.length).toBe(TEMPLATES.length);
  });

  it('should expose exactly the three decision boards, in order (working? worth it? breaking?)', () => {
    // Pins both the count AND identity/order: catches an accidental re-add of
    // a retired template and a reorder, which a bare length check would miss.
    expect(getTemplateList().map((t) => t.id)).toEqual([
      'agent-outcomes',
      'cost-impact',
      'agent-operations',
    ]);
  });

  it('should include id, name, description, widgetCount, and widgets on each summary when inspected', () => {
    const list = getTemplateList();
    for (const template of list) {
      expect(template).toHaveProperty('id');
      expect(template).toHaveProperty('name');
      expect(template).toHaveProperty('description');
      expect(template).toHaveProperty('widgetCount');
      expect(template).toHaveProperty('widgets');
    }
  });

  it('should set widgetCount to match the actual widgets array length when compared', () => {
    const list = getTemplateList();
    for (const template of list) {
      expect(template.widgetCount).toBe(template.widgets.length);
    }
  });

  it('should include title, metric, and visualization on each widget summary when inspected', () => {
    const list = getTemplateList();
    for (const template of list) {
      for (const widget of template.widgets) {
        expect(typeof widget.title).toBe('string');
        expect(widget.title.length).toBeGreaterThan(0);
        expect(typeof widget.metric).toBe('string');
        expect(typeof widget.visualization).toBe('string');
      }
    }
  });
});

// ============================================================================
// getTemplate (getTemplateById)
// ============================================================================

describe('getTemplate', () => {
  it('should return a template definition when given a valid ID', () => {
    const result = getTemplate('cost-impact');
    expect(result!.id).toBe('cost-impact');
    expect(result!.name).toBe('Cost & Impact');
  });

  it('should return undefined when given an invalid ID', () => {
    expect(getTemplate('nonexistent-template')).toBeUndefined();
  });

  it('should return undefined when given an empty string', () => {
    expect(getTemplate('')).toBeUndefined();
  });

  // Template ids that deliberately have no starting card. Their metrics stay
  // addable as individual widgets; pinning that these ids don't resolve makes
  // re-introducing a card a deliberate, tested act. Executive Overview folds
  // into cost-impact, and Execution Health into agent-operations.
  it.each([
    'cost-analysis',
    'performance',
    'request-analytics',
    'score-analytics',
    'repo-activity',
    'agent-autonomy',
    'executive-overview',
    'agent-fleet-overview',
    'agent-execution-health',
  ])('should no longer resolve the retired %s template', (id) => {
    expect(getTemplate(id)).toBeUndefined();
  });

  it('should return the cost-impact template when given that ID — every number a dollar or a comparison', () => {
    const result = getTemplate('cost-impact');
    expect(result!.name).toBe('Cost & Impact');
    // Positional: dollars first, then the within-org control group, then the
    // autonomy headline with its Clean Job Rate guardrail closing the board.
    expect(result!.widgets.map((w) => `${w.metric}:${w.visualization}`)).toEqual([
      'agent_cost_per_merged_pr:stat',
      'total_cost_of_ai:stat',
      'agent_spend_per_active_dev:stat',
      'agent_unshipped_spend_share:stat',
      // The controlled-experiment complement to the observational cost tiles.
      'agent_cost_per_resolved_task:stat',
      'agent_share_of_merged_prs:stat',
      'agent_vs_human_cycle_time:bar',
      'agent_vs_human_first_pass_ci:bar',
      'agent_vs_human_pr_size:bar',
      'agent_shipped_autonomy_trend:area',
      'agent_clean_job_rate:stat',
    ]);
    // No section headers: eleven widgets fit on one screen — the question
    // framing lives in the board's name now, not in banner rows.
    expect(result!.widgets.some((w) => w.metric === 'section_header')).toBe(false);
  });

  it('should return the agent-outcomes template when given that ID, with score widgets bound to the worker.* names', () => {
    const result = getTemplate('agent-outcomes');
    expect(result!.name).toBe('Agent Outcomes');
    // Positional: session-grain outcome scores lead (summary first — every
    // score name present joins that widget automatically), the PR-grain
    // lifecycle tiles close the board as the cross-source check.
    expect(result!.widgets.map((w) => `${w.metric}:${w.visualization}:${w.scoreName ?? ''}`)).toEqual([
      'score_summary:stat:',
      'score_trend:line:worker.ci_green',
      'score_histogram:bar:worker.merged',
      'score_trend:line:worker.reverted',
      'agent_pr_merge_rate:stat:',
      'agent_pr_revert_rate:stat:',
      'agent_clean_job_rate:stat:',
      'agent_pr_outcome_by_score_merge_rate:stat:worker.ci_green',
    ]);
    // Fate-derived scores must never be a predictor axis: this board carries
    // no score_comparison widget (that correlation view is a separate,
    // deliberately-designed surface), and the one correlation widget it DOES
    // carry is keyed to worker.ci_green specifically — the one outcome score
    // that isn't fate-derived (Source: 'ci', not 'outcome').
    expect(result!.widgets.some((w) => w.metric === 'score_comparison')).toBe(false);
    expect(
      result!.widgets.filter((w) => w.metric.startsWith('agent_pr_outcome_by_score')),
    ).toEqual([
      {
        title: 'Merge Rate by First-Pass CI',
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'worker.ci_green',
      },
    ]);
  });

  it('should return the agent-operations template when given that ID, staying process-only', () => {
    const result = getTemplate('agent-operations');
    expect(result!.name).toBe('Agent Operations');
    // Positional: the four floors, the two by-branch cuts, the trajectory
    // signals, the run-shape trends.
    expect(result!.widgets.map((w) => `${w.metric}:${w.visualization}`)).toEqual([
      'tool_error_rate:stat',
      'clean_session_rate:stat',
      'agent_hands_on_rate:stat',
      'agent_pr_unreviewed_merge_rate:stat',
      'agent_tool_error_rate_by_branch:bar',
      'agent_cost_anomalies_by_branch:bar',
      'agent_trajectory_signals_trend:line',
      'agent_interventions_trend:line',
      'agent_session_duration_trend:line',
      'agent_turn_count_trend:line',
    ]);
    // Outcome/durability live on agent-outcomes — a red tile here always
    // means "go look at the machinery," never "the work was bad."
    expect(result!.widgets.some((w) => w.metric.includes('revert') || w.metric.includes('reopen') || w.metric.startsWith('score_'))).toBe(false);
  });

  it('should keep the bounded-overlap rule: a metric on at most two boards, the second only as a declared guardrail', () => {
    const counts = new Map<string, number>();
    for (const template of TEMPLATES) {
      for (const metric of new Set(template.widgets.map((w) => w.metric))) {
        counts.set(metric, (counts.get(metric) ?? 0) + 1);
      }
    }
    const GUARDRAILS = new Set(['agent_clean_job_rate']);
    expect([...counts].filter(([, c]) => c > 2).map(([m]) => m)).toEqual([]);
    expect([...counts].filter(([m, c]) => c === 2 && !GUARDRAILS.has(m)).map(([m]) => m)).toEqual([]);
  });

  it('should give every stat tile on a template an evidence tier, except the score summary', () => {
    // The credibility rule made structural: a stat tile ships on a pre-built
    // board only when its info affordance can say how the number is grounded.
    // score_summary is exempt — it lists scores, each already an
    // evidence-bearing row.
    const missing: string[] = [];
    for (const template of TEMPLATES) {
      for (const widget of template.widgets) {
        if (widget.visualization !== 'stat' || widget.metric === 'score_summary') continue;
        if (!getMetricEvidenceLine(widget.metric)) missing.push(`${template.id}/${widget.metric}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('should no longer resolve the old reliability template ID', () => {
    expect(getTemplate('reliability')).toBeUndefined();
  });
});

// ============================================================================
// Template structure integrity
// ============================================================================

describe('Template structure', () => {
  it('should have a non-empty widgets array on every template when inspected', () => {
    for (const template of TEMPLATES) {
      expect(template.widgets.length).toBeGreaterThan(0);
    }
  });

  it('should have a layout array matching widget count on every template when compared', () => {
    for (const template of TEMPLATES) {
      expect(template.layout.length).toBe(template.widgets.length);
    }
  });

  it('should have name and description as non-empty strings on every template when inspected', () => {
    for (const template of TEMPLATES) {
      expect(typeof template.name).toBe('string');
      expect(template.name.length).toBeGreaterThan(0);
      expect(typeof template.description).toBe('string');
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  it('should have unique IDs when all template IDs are compared', () => {
    const ids = TEMPLATES.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ============================================================================
// Template widget validation
// ============================================================================

describe('Template widget metrics and visualizations', () => {
  it('should use only valid metric IDs when all template widgets are checked', () => {
    const validMetrics = new Set<string>(ALL_METRIC_IDS);
    for (const template of TEMPLATES) {
      for (const widget of template.widgets) {
        expect(validMetrics.has(widget.metric)).toBe(true);
      }
    }
  });

  it('should use only valid visualization types when all template widgets are checked', () => {
    const validViz = new Set<string>(VISUALIZATION_TYPES);
    for (const template of TEMPLATES) {
      for (const widget of template.widgets) {
        const viz = widget.visualization ?? 'line';
        expect(validViz.has(viz)).toBe(true);
      }
    }
  });

  it('should have non-empty title strings when all template widgets are checked', () => {
    for (const template of TEMPLATES) {
      for (const widget of template.widgets) {
        expect(typeof widget.title).toBe('string');
        expect(widget.title.length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================
// Template layout validation
// ============================================================================

describe('Template layout positions', () => {
  it('should have x, y, w, h all >= 0 on every layout item when inspected', () => {
    for (const template of TEMPLATES) {
      for (const item of template.layout) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.w).toBeGreaterThanOrEqual(0);
        expect(item.h).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('should have positive w and h values on every layout item when inspected', () => {
    for (const template of TEMPLATES) {
      for (const item of template.layout) {
        expect(item.w).toBeGreaterThan(0);
        expect(item.h).toBeGreaterThan(0);
      }
    }
  });

  it('should not exceed a 12-column grid width when layout x+w is checked', () => {
    for (const template of TEMPLATES) {
      for (const item of template.layout) {
        expect(item.x + item.w).toBeLessThanOrEqual(12);
      }
    }
  });

  it('should have widgetId as a string on every layout item when inspected', () => {
    for (const template of TEMPLATES) {
      for (const item of template.layout) {
        expect(typeof item.widgetId).toBe('string');
      }
    }
  });
});

// ============================================================================
// DEFAULT_TEMPLATE_ID
// ============================================================================

describe('DEFAULT_TEMPLATE_ID', () => {
  it('should reference a template that exists when looked up in TEMPLATES', () => {
    const result = getTemplate(DEFAULT_TEMPLATE_ID);
    // The default id must resolve to a real template whose own id round-trips.
    expect(result!.id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('should be set to agent-outcomes when checked — the trust board leads', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('agent-outcomes');
  });
});
