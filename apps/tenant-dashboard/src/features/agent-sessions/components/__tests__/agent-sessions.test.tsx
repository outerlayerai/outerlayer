// @vitest-environment jsdom
/**
 * The sessions LIST component: presentational + navigation-driving over a
 * `data` page seeded by a React Server Component (RSC). Every filter/sort/page
 * control writes the next URL
 * via `router.replace` (the RSC page re-fetches under those params on the
 * next render) — we pin the resulting URL rather than a hook call, since the
 * component now holds no fetch of its own. Deep-link state (search, filters,
 * origin, topic) is read straight from `useSearchParams()`, so seeding it is
 * just seeding the mocked URL.
 */
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { vi } from 'vitest';
import type { SessionsPage } from '../../types';

const replace = vi.fn();
const push = vi.fn();
let urlParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useParams: () => ({ orgName: 'acme', appName: 'app' }),
  useRouter: () => ({ replace, push }),
  usePathname: () => '/orgs/acme/apps/app/env/dev/agents/sessions',
  useSearchParams: () => urlParams,
}));

vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({ icon, ...rest }: { icon: string } & Record<string, unknown>) => (
    <span data-testid={`icon-${icon}`} {...rest} />
  ),
}));

const saveView = vi.fn();
const removeView = vi.fn();
let mockViews: { id: string; name: string; filter_config: Record<string, unknown> }[] = [];
vi.mock('@/hooks/use-saved-views', () => ({
  useSavedViews: () => ({ views: mockViews, save: saveView, remove: removeView }),
}));

import { AgentSessions } from '../agent-sessions';

const SESSION = {
  traceId: 't1',
  sessionId: 's1',
  title: 'Fix the build',
  agentType: 'claude-code',
  actorId: 'membership-1',
  workerKind: null,
  project: 'github.com/acme/app',
  branch: 'main',
  startedAt: '2026-07-08T10:00:00.000Z',
  durationMs: null,
  turnCount: 12,
  toolCallCount: 30,
  errorCount: 1,
  costUsd: 4.2,
  userTurnCount: 3,
  rejectedToolCallCount: 1,
  models: ['claude-opus-4-8'],
  origin: 'interactive',
  prOutcomes: [],
};

const PAGE: SessionsPage = {
  repo: 'github.com/acme/app',
  scope: 'team',
  total: 1,
  branches: ['main'],
  actors: ['membership-1'],
  actorNames: {},
  agentTypes: ['claude-code', 'gemini-cli'],
  models: [],
  workerKinds: [],
  sessions: [SESSION],
};

const lastReplaceUrl = () => String(replace.mock.calls.at(-1)?.[0] ?? '');
const lastReplaceParams = () => new URLSearchParams(lastReplaceUrl().split('?')[1] ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  urlParams = new URLSearchParams();
  mockViews = [];
});

describe('AgentSessions', () => {
  it('renders the repo scope, total, and session rows from the seeded page', () => {
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    expect(screen.getByText('github.com/acme/app')).toBeInTheDocument();
    expect(screen.getByText('· 1 sessions')).toBeInTheDocument();
    expect(screen.getByText('Fix the build')).toBeInTheDocument();
    // follow-ups column: userTurnCount − 1, breakdown in the title
    const followUpsCell = screen.getByTitle('user turns: 3 · denied tool calls: 1');
    expect(followUpsCell.textContent).toBe('2');
  });

  it('outcome column: a single-PR session shows one pill; a session with no PR shows a dash', () => {
    const data: SessionsPage = {
      ...PAGE,
      total: 2,
      sessions: [
        { ...SESSION, traceId: 'p1', title: 'Shipped a change', prOutcomes: [{ prNumber: 501, prUrl: null, ciGreen: { score: 1, label: 'success' }, merged: { score: 1, label: 'merged' }, reverted: { score: 0, label: 'standing' } }] },
        { ...SESSION, traceId: 'n1', title: 'Just explored', prOutcomes: [] },
      ],
    };
    render(<AgentSessions data={data} appId="app-1" envName="dev" />);
    // single PR → a merged pill (no count, no caret)
    expect(screen.getByText('merged')).toBeInTheDocument();
    // no-PR session still renders — the strip is absent for it
    expect(screen.getByText('Just explored')).toBeInTheDocument();
  });

  it('outcome column: a multi-PR session shows the fate set + count and expands to a row per PR', () => {
    const data: SessionsPage = {
      ...PAGE,
      total: 1,
      sessions: [
        {
          ...SESSION,
          traceId: 'm1',
          title: 'Stacked work',
          prOutcomes: [
            { prNumber: 601, prUrl: 'https://github.com/acme/app/pull/601', ciGreen: { score: 1, label: 'success' }, merged: { score: 1, label: 'merged' }, reverted: { score: 0, label: 'standing' } },
            { prNumber: 602, prUrl: null, ciGreen: { score: 0, label: 'failure' }, merged: { score: 1, label: 'merged' }, reverted: { score: 1, label: 'reverted' } },
          ],
        },
      ],
    };
    render(<AgentSessions data={data} appId="app-1" envName="dev" />);
    // collapsed: the SET of fates present (merged AND reverted), + count 2 —
    // a merge can't hide the revert. PR numbers are not shown until expanded.
    expect(screen.getByText('merged')).toBeInTheDocument();
    expect(screen.getByText('reverted')).toBeInTheDocument();
    expect(screen.queryByText('#601')).not.toBeInTheDocument();

    // expand → one sub-row per PR, each with its own PR number
    fireEvent.click(screen.getByTitle('Show each PR'));
    const pr601 = screen.getByText('#601').closest('a');
    expect(pr601).toHaveAttribute('href', 'https://github.com/acme/app/pull/601');
    expect(pr601).toHaveAttribute('target', '_blank');
    expect(screen.getByText('#602').closest('a')).toBeNull();
  });

  it('topic drill-down: shows a chip labelled by facet + name, and clearing it drops the topic params', () => {
    urlParams = new URLSearchParams('topicId=v1-c0&topicFacet=task&topicName=Refunds');
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    const chip = screen.getByTestId('topic-drilldown-chip');
    expect(chip).toHaveTextContent('task');
    expect(chip).toHaveTextContent('Refunds');

    fireEvent.click(screen.getByTestId('CancelIcon')); // MUI Chip onDelete icon
    const next = lastReplaceParams();
    expect(next.has('topicId')).toBe(false);
    expect(next.has('topicFacet')).toBe(false);
  });

  it('shows an empty state (not a blank body) when the filter matches no sessions', () => {
    render(<AgentSessions data={{ ...PAGE, total: 0, sessions: [] }} appId="app-1" envName="dev" />);
    const empty = screen.getByTestId('sessions-empty');
    // A heading plus an explanation of how to get out of the empty view — a
    // bare sentence would leave the reader with nothing to act on.
    expect(screen.getByRole('heading', { name: 'No sessions match this filter' })).toBeInTheDocument();
    expect(empty).toHaveTextContent(/clear a filter token/i);
    // Empty is not a table with zero rows: the table and its pager are gone.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-pager')).not.toBeInTheDocument();
  });

  it('titles the page and captions it with the repo and the total match count', () => {
    render(<AgentSessions data={{ ...PAGE, total: 1234 }} appId="app-1" envName="dev" />);
    const heading = screen.getByRole('heading', { name: 'Sessions' });
    expect(heading.tagName).toBe('H4');
    // The count is the total across every page, not the current page's length.
    const header = screen.getByTestId('page-header');
    expect(header).toHaveTextContent('github.com/acme/app');
    expect(header).toHaveTextContent('· 1,234 sessions');
  });

  it('deep-linked filter/sort/page state renders in the UI (search box, page position and range)', () => {
    urlParams = new URLSearchParams('agent=gemini-cli&q=fix&sort=cost&dir=asc&page=2');
    render(<AgentSessions data={{ ...PAGE, total: 120 }} appId="app-1" envName="dev" />);
    expect(screen.getByPlaceholderText('Search titles…')).toHaveValue('fix');
    // The URL's `page` is zero-based and reaches the pager untranslated:
    // page=2 is the third of five 25-row pages, rows 51–75 of 120.
    expect(screen.getByTestId('table-pager-position')).toHaveTextContent('3 / 5');
    expect(screen.getByTestId('table-pager-range')).toHaveTextContent('51–75 of 120');
  });

  it('paging back to the first page drops the page param instead of writing page=0', () => {
    urlParams = new URLSearchParams('page=1');
    render(<AgentSessions data={{ ...PAGE, total: 120 }} appId="app-1" envName="dev" />);
    fireEvent.click(screen.getByRole('button', { name: /Prev/ }));
    expect(lastReplaceParams().has('page')).toBe(false);
  });

  it('Next advances the zero-based page param by one', () => {
    urlParams = new URLSearchParams('page=1');
    render(<AgentSessions data={{ ...PAGE, total: 120 }} appId="app-1" envName="dev" />);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(lastReplaceParams().get('page')).toBe('2');
  });

  it('debounced search commits to the URL as q and resets the page', async () => {
    vi.useFakeTimers();
    try {
      urlParams = new URLSearchParams('page=3');
      render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
      fireEvent.change(screen.getByPlaceholderText('Search titles…'), { target: { value: 'deploy' } });
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      const next = lastReplaceParams();
      expect(next.get('q')).toBe('deploy');
      expect(next.has('page')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sort header click flips to that column desc, second click toggles asc', () => {
    const first = render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    fireEvent.click(first.getByText('Cost'));
    let next = lastReplaceParams();
    expect(next.get('sort')).toBe('cost');
    expect(next.has('dir')).toBe(false); // desc is the default, omitted
    first.unmount();

    urlParams = new URLSearchParams('sort=cost');
    const second = render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    fireEvent.click(second.getByText('Cost'));
    next = lastReplaceParams();
    expect(next.get('sort')).toBe('cost');
    expect(next.get('dir')).toBe('asc');
  });

  it('tool-error-rate column: rate computed from the row, dash when clean, sortable header', () => {
    const data: SessionsPage = {
      ...PAGE,
      total: 2,
      sessions: [
        { ...SESSION, traceId: 'e1', title: 'Errored run', errorCount: 3, toolCallCount: 12 },
        { ...SESSION, traceId: 'c1', title: 'Clean run', errorCount: 0, toolCallCount: 8 },
      ],
    };
    render(<AgentSessions data={data} appId="app-1" envName="dev" />);
    // 3 of 12 → 25%; the tooltip carries the exact fraction.
    const erroredCell = screen.getByTitle('3 of 12 tool calls failed');
    expect(erroredCell.textContent).toBe('25%');
    expect(screen.getByTitle('0 of 8 tool calls failed').textContent).toBe('—');
    fireEvent.click(screen.getByText('Err %'));
    expect(lastReplaceParams().get('sort')).toBe('toolErrorRate');
  });

  it('signal facet: picking a bucket lands in the URL as signal, and clears from its token', () => {
    const first = render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    fireEvent.click(first.getByRole('button', { name: /filter/i }));
    fireEvent.click(first.getByRole('menuitem', { name: 'hands-on (any follow-up)' }));
    expect(lastReplaceParams().get('signal')).toBe('hands-on');
    first.unmount();

    urlParams = new URLSearchParams('signal=hands-on');
    const second = render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    const token = second.getByText('trajectory: hands-on (any follow-up)');
    fireEvent.click(within(token.closest('.MuiChip-root') as HTMLElement).getByTestId('CancelIcon'));
    expect(lastReplaceParams().has('signal')).toBe(false);
  });

  it('a deep link with an unknown signal token falls back to no active filter', () => {
    urlParams = new URLSearchParams('signal=bogus');
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    // No active filter token rendered for the unknown value.
    expect(screen.queryByText(/^trajectory:/)).not.toBeInTheDocument();
  });

  it('writes the active state to the URL and clicking a row opens the detail under the current env', () => {
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    fireEvent.click(screen.getByText('Fix the build'));
    expect(push).toHaveBeenCalledWith('/orgs/acme/apps/app/env/dev/agents/sessions/t1');
  });

  it('defaults to the People segment (no origin param); picking Agents narrows and lands origin=agent in the URL', () => {
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    expect(screen.getByRole('button', { name: 'People' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(lastReplaceParams().get('origin')).toBe('agent');
  });

  it('the All segment is an explicit choice: URL carries origin=all (not omitted)', () => {
    urlParams = new URLSearchParams('origin=agent');
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    // Every-origin is a deviation from the People default, so it must survive
    // in the URL — a bare path would snap back to People on reload.
    expect(lastReplaceParams().get('origin')).toBe('all');
  });

  it('a deep link with origin=all lands on the All segment', () => {
    urlParams = new URLSearchParams('origin=all');
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('segment badges show the per-origin totals from the response', () => {
    const data: SessionsPage = { ...PAGE, originCounts: { interactive: 99, agent: 267, worker: 3 } };
    render(<AgentSessions data={data} appId="app-1" envName="dev" />);
    // People = interactive + worker runs.
    expect(screen.getByRole('button', { name: 'People' })).toHaveTextContent('People (102)');
    expect(screen.getByRole('button', { name: 'Agents' })).toHaveTextContent('Agents (267)');
    expect(screen.getByRole('button', { name: 'All' })).toHaveTextContent('All (369)');
  });

  /* The caption renders during SSR from the RSC-seeded page, so a formatter
   * that reads the ambient locale groups one way on the server and another in
   * the visitor's browser. The stub stands in for a browser whose separator
   * differs; asserting "1,234,567" alone would pass under the ambient en-US
   * formatter too. */
  it('groups the session total without consulting the ambient locale', () => {
    const ambient = vi
      .spyOn(Number.prototype, 'toLocaleString')
      .mockReturnValue('AMBIENT_LOCALE');
    const data: SessionsPage = { ...PAGE, total: 1234567 };

    render(<AgentSessions data={data} appId="app-1" envName="dev" />);

    // A formatter reading the stub would render "· AMBIENT_LOCALE sessions".
    expect(screen.getByText(/· 1,234,567 sessions/)).toBeInTheDocument();

    ambient.mockRestore();
  });

  it('in the All view, an agent-origin row is chipped "Agent" and an interactive row is not', () => {
    urlParams = new URLSearchParams('origin=all');
    const data: SessionsPage = {
      ...PAGE,
      total: 2,
      sessions: [
        { ...SESSION, traceId: 'a1', title: 'Nightly agent run', origin: 'agent' },
        { ...SESSION, traceId: 'i1', title: 'Human debugging', origin: 'interactive' },
      ],
    };
    render(<AgentSessions data={data} appId="app-1" envName="dev" />);
    const agentRow = screen.getByText('Nightly agent run').closest('tr')!;
    const interactiveRow = screen.getByText('Human debugging').closest('tr')!;
    expect(within(agentRow).getByText('Agent')).toBeInTheDocument();
    expect(within(interactiveRow).queryByText('Agent')).not.toBeInTheDocument();
  });

  it('save view stores the current query (minus non-persisted params); applying a view navigates to its stored query', () => {
    urlParams = new URLSearchParams('agent=gemini-cli');
    mockViews = [{ id: 'v1', name: 'Gemini', filter_config: { v: 1, query: 'agent=gemini-cli&range=7d' } }];
    render(<AgentSessions data={PAGE} appId="app-1" envName="dev" />);

    // save current filters under a name
    fireEvent.click(screen.getByRole('button', { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText('View name…'), { target: { value: 'Gemini' } });
    fireEvent.keyDown(screen.getByPlaceholderText('View name…'), { key: 'Enter' });
    expect(saveView).toHaveBeenCalledWith('Gemini', { v: 1, query: 'agent=gemini-cli' });

    // apply the stored view → router.replace with the stored query
    fireEvent.click(screen.getByRole('button', { name: /^Views$/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Gemini/ }));
    expect(replace).toHaveBeenCalledWith(
      '/orgs/acme/apps/app/env/dev/agents/sessions?agent=gemini-cli&range=7d',
      { scroll: false },
    );
  });
});
