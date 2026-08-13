// @vitest-environment jsdom
/**
 * <Topics> card — presentation over the topic map seeded by a React Server
 * Component (RSC).
 *
 * Boundaries:
 *  - `topics`/`error` arrive as props (the RSC read owns fetching); this test
 *    drives every UI state by passing them directly — cold-start, populated,
 *    error, generation outcomes.
 *  - `useGenerateTopics` (the generate-action wrapper) and `useSetupGate` are
 *    mocked context seams.
 *  - `next/navigation` (useRouter/usePathname/useSearchParams) comes from the
 *    global unit-test setup; `usePathname` defaults to `/test-path`.
 */

import { render, screen, within, fireEvent } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRouter, useSearchParams } from 'next/navigation';
import type { GenerateOutcome, TopicsList } from '@/lib/analytics/topics/topics-shared';
import { Topics, type TopicsProps } from '../topics';

// The topics-over-time chart renders react-apexcharts (loaded via next/dynamic);
// ApexCharts calls SVG APIs (getScreenCTM) that jsdom doesn't implement. Stub it
// — the chart's own behavior isn't what this test covers.
vi.mock('react-apexcharts', () => ({ default: () => null }));

const mockUseGenerateTopics = vi.fn();
vi.mock('../../hooks/use-topics', () => ({
  useGenerateTopics: (appId: string, facet: string) => mockUseGenerateTopics(appId, facet),
}));

const mockUseSetupGate = vi.fn();
vi.mock('@/lib/app-shell/use-setup-gate', () => ({
  useSetupGate: () => mockUseSetupGate(),
}));

const push = vi.fn();
const refresh = vi.fn();

function populatedList(overrides: Partial<TopicsList> = {}): TopicsList {
  return {
    facet: 'task',
    mapVersion: 2,
    generatedAt: '2026-07-01 12:00:00.000',
    topics: [
      { topicId: 'v1-c0', name: 'Refund Requests', description: 'Refund asks.', sessionCount: 60, share: 0.6, avgLatencyMs: 820, avgCostUsd: 0.012, trend: [1, 2, 3] },
      { topicId: 'v1-c1', name: 'Login Problems', description: 'Login failures.', sessionCount: 30, share: 0.3, avgLatencyMs: 640, avgCostUsd: 0.008, trend: [0, 1, 2] },
    ],
    noMatchCount: 10,
    samplableCount: 100,
    required: 100,
    trendDays: ['2026-07-01 10:00:00', '2026-07-01 11:00:00', '2026-07-01 12:00:00'],
    noMatchTrend: [0, 0, 1],
    trendBucket: 'hour',
    ...overrides,
  };
}

function buildGenerateHookReturn(over: Record<string, unknown> = {}) {
  return {
    generating: false,
    lastOutcome: null as GenerateOutcome | null,
    generate: vi.fn().mockResolvedValue({ status: 'generated' }),
    ...over,
  };
}

function setGenerateHook(over: Record<string, unknown> = {}) {
  mockUseGenerateTopics.mockReturnValue(buildGenerateHookReturn(over));
}

function renderTopics(over: Partial<TopicsProps> = {}) {
  const props: TopicsProps = {
    appId: 'app-1',
    facet: 'task',
    topics: null,
    error: null,
    ...over,
  };
  return render(<Topics {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>);
  mockUseSetupGate.mockReturnValue({ pending: false, showSetup: false });
  setGenerateHook();
});

describe('<Topics> gating', () => {
  it('renders nothing while the setup gate is pending', () => {
    mockUseSetupGate.mockReturnValue({ pending: true, showSetup: false });
    const { container } = renderTopics({ topics: populatedList() });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the onboarding setup page owns the route', () => {
    mockUseSetupGate.mockReturnValue({ pending: false, showSetup: true });
    const { container } = renderTopics({ topics: populatedList() });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('<Topics> cold start (no map)', () => {
  it('shows the empty state with the summaries-collected counter and disables Generate below the floor', () => {
    // 40 samplable of 100 → below floor.
    renderTopics({ topics: populatedList({ mapVersion: 0, generatedAt: null, topics: [], noMatchCount: 0, samplableCount: 40 }) });

    expect(screen.getByTestId('topics-empty-state')).toBeInTheDocument();
    // The counter is metadata about the absence, so it belongs in the meta
    // slot — in the action slot it would read as the way past the floor.
    expect(screen.getByTestId('topics-empty-state-meta')).toHaveTextContent(
      '40 of 100 summaries collected',
    );
    const button = screen.getByTestId('generate-topics');
    expect(button).toHaveTextContent('Generate topics');
    expect(button).toBeDisabled();
    expect(screen.queryByTestId('topics-table')).not.toBeInTheDocument();
  });

  it('enables Generate once the summary floor is reached', () => {
    renderTopics({ topics: populatedList({ mapVersion: 0, generatedAt: null, topics: [], noMatchCount: 0, samplableCount: 100 }) });
    expect(screen.getByTestId('generate-topics')).toBeEnabled();
  });

  it('gates Regenerate on the server samplable count, never on assigned-session arithmetic', () => {
    // A populated map with 100 assigned sessions but only 12 samplable rows:
    // summing displayed counts would enable a button generation must refuse
    // (assigned counts are SESSION-grain and include rows generation excludes).
    renderTopics({ topics: populatedList({ samplableCount: 12 }) });
    expect(screen.getByTestId('generate-topics')).toBeDisabled();
    // A silently-dead Regenerate beside a rendered map reads as a bug: the
    // header caption carries the why — progress toward the floor.
    expect(screen.getByText(/12\/100 toward next regeneration/)).toBeInTheDocument();
  });

  it('hides the regeneration-progress caption once the floor is met', () => {
    renderTopics({ topics: populatedList({ samplableCount: 100 }) });
    expect(screen.getByTestId('generate-topics')).toBeEnabled();
    expect(screen.queryByText(/toward next regeneration/)).not.toBeInTheDocument();
  });

  it('explains the disabled button on hover — count, floor, and that summaries accrue on their own', async () => {
    renderTopics({ topics: populatedList({ samplableCount: 12 }) });
    fireEvent.mouseOver(screen.getByTestId('generate-topics').parentElement!);
    expect(
      await screen.findByText(
        'Needs 100 summaries at the current extraction version (12 so far). Summaries accrue automatically as sessions are analyzed and re-analyzed.',
      ),
    ).toBeInTheDocument();
  });

  it('treats a null topics prop as zero collected', () => {
    renderTopics({ topics: null });
    expect(screen.getByText('0 of 100 summaries collected')).toBeInTheDocument();
    expect(screen.getByTestId('generate-topics')).toBeDisabled();
  });
});

describe('<Topics> populated map', () => {
  /* The map's freshness stamp renders from the RSC-seeded prop, so a timestamp
   * formatted during SSR would hydrate into a mismatch for any visitor whose
   * timezone differs from the server's. It fills in after mount instead. */
  it('keeps the freshness timestamp out of the server render', () => {
    const html = renderToString(<Topics appId="app-1" facet="task" topics={populatedList()} error={null} />);

    // React separates adjacent text nodes with comment markers in the server
    // stream, so compare against the visible text rather than the raw markup.
    expect(html.replace(/<!--.*?-->/g, '')).toContain('Map v2 · generated');
    expect(html).toContain('local-date-placeholder');
    expect(html).not.toMatch(/Jul|July|2026|12:00/);
  });

  it('shows the freshness timestamp once mounted', () => {
    renderTopics({ topics: populatedList() });

    // Formatted in the visitor's zone, so pin the shape rather than a fixed
    // clock reading — an assertion on one exact time would only hold on a host
    // sitting in the zone that produced it. The shape itself is the runner's
    // en-US ordering; a differently-localed runner would need a different one.
    expect(screen.getByTestId('page-header')).toHaveTextContent(
      /Map v2 · generated [A-Za-z]{3,5}\.? \d{1,2}, \d{1,2}:\d{2}/,
    );
  });

  // proves AC-056-05
  // proves AC-056-06
  it('renders topic rows sorted as given, with counts and share, plus the no-match row', () => {
    renderTopics({ topics: populatedList() });

    expect(screen.getByTestId('generate-topics')).toHaveTextContent('Regenerate topics');
    expect(screen.getByText(/Map v2 · generated/)).toBeInTheDocument();

    const refund = screen.getByTestId('topic-row-v1-c0');
    expect(within(refund).getByText('Refund Requests')).toBeInTheDocument();
    expect(within(refund).getByText('60')).toBeInTheDocument();
    expect(within(refund).getByText('60%')).toBeInTheDocument();

    const login = screen.getByTestId('topic-row-v1-c1');
    expect(within(login).getByText('30%')).toBeInTheDocument();

    const noMatch = screen.getByTestId('topic-row-no-match');
    expect(within(noMatch).getByText('No match')).toBeInTheDocument();
    expect(within(noMatch).getByText('10')).toBeInTheDocument();
  });

  it('renders a per-row trend sparkline for each topic and the no-match row', () => {
    renderTopics({ topics: populatedList() });
    // Each topic carries its own inline sparkline (an svg polyline over the
    // hourly buckets), independent of the aggregate chart above.
    expect(screen.getByTestId('topic-trend-v1-c0').querySelector('polyline')).toBeInTheDocument();
    expect(screen.getByTestId('topic-trend-v1-c1').querySelector('polyline')).toBeInTheDocument();
    // The no-match bucket gets one too — its trajectory is the regenerate signal.
    expect(screen.getByTestId('topic-trend-no-match').querySelector('polyline')).toBeInTheDocument();
  });

  it('draws a flat baseline (not a phantom spike) when a topic has no movement', () => {
    renderTopics({
      topics: populatedList({
        topics: [
          { topicId: 'v1-c0', name: 'Flat', description: '', sessionCount: 5, share: 1, avgLatencyMs: 0, avgCostUsd: 0, trend: [2, 2, 2] },
        ],
        noMatchCount: 0,
      }),
    });
    const spark = screen.getByTestId('topic-trend-v1-c0');
    expect(spark.querySelector('polyline')).not.toBeInTheDocument();
    expect(spark.querySelector('line')).toBeInTheDocument();
    expect(spark).toHaveAttribute('aria-label', 'No trend data');
  });

  it('hides the no-match row when there are no unmatched traces', () => {
    renderTopics({ topics: populatedList({ noMatchCount: 0 }) });
    expect(screen.queryByTestId('topic-row-no-match')).not.toBeInTheDocument();
  });

  it('topic click drills into the Sessions list scoped to that topic + facet', () => {
    // Clicking a topic opens the sessions list filtered to that topic's
    // sessions, carrying topicId/topicFacet (+ a display name) on the URL.
    renderTopics({ topics: populatedList() });
    fireEvent.click(screen.getByTestId('topic-row-v1-c0'));
    expect(push).toHaveBeenNthCalledWith(
      1,
      '/test-path?topicId=v1-c0&topicFacet=task&topicName=Refund+Requests',
    );
    fireEvent.click(screen.getByTestId('topic-row-no-match'));
    expect(push).toHaveBeenNthCalledWith(
      2,
      '/test-path?topicId=no_match&topicFacet=task&topicName=No+match',
    );
  });
});

describe('<Topics> page header', () => {
  it('carries the title, the freshness caption, and both page actions in the header', () => {
    renderTopics({ topics: populatedList({ samplableCount: 12 }) });

    // The page title is always h4; the test harness's translator echoes the key.
    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 4 })).toHaveTextContent(
      'dashboard.sidebar.topics',
    );
    // Freshness is header metadata, not a footer note, and below the floor it
    // also carries the reason Regenerate is dead.
    expect(within(header).getByText(/Map v2 · generated/)).toHaveTextContent(
      /12\/100 toward next regeneration/,
    );

    // Facet switching and Regenerate are page-level actions: both sit in the
    // header's trailing slot, not loose in the body.
    const actions = screen.getByTestId('page-header-actions');
    expect(within(actions).getByTestId('facet-task')).toBeInTheDocument();
    expect(within(actions).getByTestId('facet-steering')).toBeInTheDocument();
    expect(within(actions).getByTestId('facet-issues')).toBeInTheDocument();
    expect(within(actions).getByTestId('generate-topics')).toHaveTextContent(
      'Regenerate topics',
    );
  });

  it('omits the freshness caption before the first map exists', () => {
    renderTopics({ topics: populatedList({ mapVersion: 0, generatedAt: null, topics: [] }) });
    expect(screen.queryByText(/generated/)).not.toBeInTheDocument();
  });
});

describe('<Topics> facet toggle', () => {
  it('switching to Issues navigates with the issues facet in the URL', () => {
    renderTopics({ topics: populatedList() });
    fireEvent.click(screen.getByTestId('facet-issues'));
    expect(push).toHaveBeenCalledWith('/test-path?facet=issues', { scroll: false });
  });

  it('switching to Steering navigates with the steering facet in the URL', () => {
    renderTopics({ topics: populatedList() });
    fireEvent.click(screen.getByTestId('facet-steering'));
    expect(push).toHaveBeenCalledWith('/test-path?facet=steering', { scroll: false });
  });
});

describe('<Topics> steering facet presentation', () => {
  it('never renders an error-rate column — the underlying flag measures session length, not quality', () => {
    // A session counted as errored if ANY span carries an error status: error
    // spans hold flat near 1.6% of all spans at every size, yet the share of
    // sessions tripping the flag climbs from 3.7% (6-20 spans) to 97.7%
    // (500+). Rendered, it read as "86% of these sessions went wrong" when
    // almost none had.
    renderTopics({ topics: populatedList() });
    expect(screen.queryByText('Errors')).not.toBeInTheDocument();
    const row = screen.getByTestId('topic-row-v1-c0');
    expect(within(row).queryByText(/%$/)).not.toBeNull(); // Share still renders a %
  });

  it('labels session wall-clock as duration, not latency', () => {
    // The figure spans a session's first to last activity, idle included —
    // real sessions report 198h. As "latency" it invites a responsiveness
    // reading it cannot support.
    renderTopics({ topics: populatedList() });
    expect(screen.getByText('Avg duration')).toBeInTheDocument();
    expect(screen.queryByText('Avg latency')).not.toBeInTheDocument();
  });

  it('drops the outcome columns (cost / duration) but keeps the recurrence count', () => {
    // Task facet carries the per-session outcome snapshots.
    const task = renderTopics({ facet: 'task', topics: populatedList() });
    expect(screen.getByText('Avg cost')).toBeInTheDocument();
    expect(screen.getByText('Avg duration')).toBeInTheDocument();
    task.unmount();

    // A correction cluster isn't a run: the steering facet drops the
    // session-outcome columns, and no dollar figure sits beside a correction
    // to imply a "waste" cost.
    renderTopics({
      facet: 'steering',
      topics: populatedList({ facet: 'steering', captureTier: 'full' }),
    });
    expect(screen.queryByText('Avg cost')).not.toBeInTheDocument();
    expect(screen.queryByText('Avg duration')).not.toBeInTheDocument();
    const row = screen.getByTestId('topic-row-v1-c0');
    expect(within(row).getByText('60')).toBeInTheDocument();
    expect(within(row).queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('renders the capture-tier gate instead of the table when the tenant is below full tier', () => {
    renderTopics({
      facet: 'steering',
      topics: populatedList({ facet: 'steering', captureTier: 'redacted' }),
    });
    expect(screen.getByTestId('topics-steering-tier-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('topics-table')).not.toBeInTheDocument();
    // A capture-tier gate is its own state: never the cold-start prompt, which
    // would invite generating a map that cannot form at this tier.
    expect(screen.queryByTestId('topics-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText('No topics yet')).not.toBeInTheDocument();
    // The tenant's actual tier is named so the fix is obvious.
    expect(screen.getByText(/redacted/)).toBeInTheDocument();
  });

  it('renders the steering table (no gate) when the tenant captures at full tier', () => {
    renderTopics({
      facet: 'steering',
      topics: populatedList({ facet: 'steering', captureTier: 'full' }),
    });
    expect(screen.queryByTestId('topics-steering-tier-gate')).not.toBeInTheDocument();
    expect(screen.getByTestId('topics-table')).toBeInTheDocument();
  });
});

describe('<Topics> transient states', () => {
  it('a load error with no data shows a retryable error card — never the cold-start empty state', () => {
    renderTopics({ topics: null, error: { message: 'boom', status: 500 } });

    expect(screen.getByTestId('topics-error-state')).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    // A transient failure must not masquerade as an empty account.
    expect(screen.queryByTestId('topics-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText('No topics yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Retry now'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renders the existing map, not the error card, when an error prop accompanies a successful read', () => {
    // Defensive: `error && !topics` is the only branch that shows the error
    // card, so a map seeded alongside a (theoretically stale) error must
    // still render — never masked by an error state that would hide real data.
    renderTopics({
      topics: populatedList(),
      error: { message: 'transient 500', status: 500 },
    });

    expect(screen.getByTestId('topics-table')).toBeInTheDocument();
    expect(screen.getByText('Refund Requests')).toBeInTheDocument();
    expect(screen.queryByTestId('topics-error-state')).not.toBeInTheDocument();
  });

  it('surfaces the not-enough-data outcome from a generate attempt', () => {
    setGenerateHook({ lastOutcome: { status: 'not_enough_data', facet: 'task', sampleSize: 42, required: 100 } });
    renderTopics({
      topics: populatedList({ mapVersion: 0, generatedAt: null, topics: [], noMatchCount: 0, samplableCount: 100 }),
    });
    const alert = screen.getByTestId('not-enough-data');
    expect(alert).toHaveTextContent('42 of 100 required');
  });

  it('surfaces the no-clusters outcome (all noise) without clearing the existing map', () => {
    setGenerateHook({ lastOutcome: { status: 'no_clusters', facet: 'task', sampleSize: 120 } });
    renderTopics({ topics: populatedList() });
    expect(screen.getByTestId('no-clusters')).toHaveTextContent('found no');
    // The existing map still renders — it was not overwritten.
    expect(screen.getByTestId('topics-table')).toBeInTheDocument();
  });

  it('disables the button and shows a spinner while generating', () => {
    setGenerateHook({ generating: true });
    renderTopics({ topics: populatedList() });
    expect(screen.getByTestId('generate-topics')).toBeDisabled();
  });
});

describe('<Topics> generate action', () => {
  it('invokes generate() on click', () => {
    const generate = vi.fn().mockResolvedValue({ status: 'generated' });
    setGenerateHook({ generate });
    renderTopics({ topics: populatedList() });
    fireEvent.click(screen.getByTestId('generate-topics'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('shows an error banner when generate() rejects', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('cluster down'));
    setGenerateHook({ generate });
    renderTopics({ topics: populatedList() });
    fireEvent.click(screen.getByTestId('generate-topics'));
    expect(await screen.findByText('cluster down')).toBeInTheDocument();
  });
});

describe('<Topics> latency formatting', () => {
  it('renders hour-scale latencies as hours, minute-scale as minutes — never a five-digit seconds blob', () => {
    renderTopics({
      topics: populatedList({
        topics: [
          { topicId: 'v1-c0', name: 'Long Sessions', description: '', sessionCount: 10, share: 0.5, avgLatencyMs: 53_270_700, avgCostUsd: 0, trend: [1, 2, 3] },
          { topicId: 'v1-c1', name: 'Medium Sessions', description: '', sessionCount: 5, share: 0.25, avgLatencyMs: 150_000, avgCostUsd: 0, trend: [1, 2, 3] },
        ],
      }),
    });
    expect(screen.getByText('14.8h')).toBeInTheDocument();
    expect(screen.getByText('2.5m')).toBeInTheDocument();
    expect(screen.queryByText('53270.7s')).not.toBeInTheDocument();
  });
});
