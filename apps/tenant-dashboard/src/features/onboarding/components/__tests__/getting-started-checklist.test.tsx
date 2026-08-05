// @vitest-environment jsdom
/**
 * Tests for GettingStartedChecklist — the app-wide, dismissible progress
 * tracker. Covers: progress rendering with deep-links, the endowed-progress
 * "1 of 4" start, auto-hide when complete, dismissal persistence, and the
 * null-render guards (no app / no data).
 *
 * SWR + app context are seams; the checklist's own data→UI logic is the unit.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChecklistStatus } from '../../checklist';

const { appRef, traceRef, mockUseSWR } = vi.hoisted(() => ({
  appRef: { current: { id: 'app-1' } as { id: string } | null },
  // The checklist only renders once the first trace has landed (pre-trace,
  // trace-family pages render nothing — see `useSetupGate`).
  // Default this true so the existing render-behaviour tests are unaffected;
  // the gate is exercised by its own case below.
  traceRef: { current: true },
  mockUseSWR: vi.fn(),
}));

vi.mock('@/routes/paths', async (importOriginal) =>
  importOriginal<typeof import('@/routes/paths')>(),
);
vi.mock('next/navigation', () => ({
  useParams: () => ({ orgName: 'org', appName: 'app', envName: 'dev' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => ({ app: appRef.current, hasCreatedTrace: traceRef.current }),
}));
// The checklist builds env-scoped deep links via useSelectedEnv; mock it to
// the default env (the component would otherwise throw without an EnvProvider).
vi.mock('@/hooks/environments/use-selected-env', () => ({
  useSelectedEnv: () => ({
    name: 'dev',
    id: 'env-dev',
    isPinned: false,
    pinnedVersion: null,
    currentCommitSha: null,
    isDefault: true,
    isUnknown: false,
    nameSource: 'default',
  }),
}));
vi.mock('swr', () => ({ default: (...args: unknown[]) => mockUseSWR(...args) }));

import { GettingStartedChecklist } from '../getting-started-checklist';

const DISMISS_KEY = 'agentmark:onboarding-checklist-dismissed:app-1';
const COLLAPSED_KEY = 'agentmark:onboarding-checklist-collapsed:app-1';
const status = (s: Partial<ChecklistStatus> = {}): ChecklistStatus => ({
  hasApiKey: false,
  hasTrace: false,
  hasTeammate: false,
  hasGitConnection: false,
  hasRepoLinked: false,
  ...s,
});

beforeEach(() => {
  vi.clearAllMocks();
  appRef.current = { id: 'app-1' };
  traceRef.current = true;
  localStorage.clear();
  mockUseSWR.mockReturnValue({ data: undefined });
});
afterEach(() => localStorage.clear());

describe('GettingStartedChecklist', () => {
  it('shows 1/5 for a fresh app and deep-links the incomplete steps', () => {
    mockUseSWR.mockReturnValue({ data: status() });
    render(<GettingStartedChecklist />);

    expect(screen.getByText('dashboard.gettingStarted.checklist.title')).toBeInTheDocument();
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
    expect(
      screen.getByText('dashboard.gettingStarted.checklist.app.label'),
    ).toBeInTheDocument();

    const addKey = screen.getByRole('link', {
      name: 'dashboard.gettingStarted.checklist.apiKey.cta',
    });
    expect(addKey).toHaveAttribute('href', '/orgs/org/apps/app/env/dev/settings/api-keys');

    // The repo step deep-links to general settings, which hosts the
    // connect-git / link-repository flow.
    const linkRepo = screen.getByRole('link', {
      name: 'dashboard.gettingStarted.checklist.repo.cta',
    });
    expect(linkRepo).toHaveAttribute('href', '/orgs/org/apps/app/env/dev/settings/general');
  });

  it('renders nothing once every step is complete', () => {
    mockUseSWR.mockReturnValue({
      data: status({
        hasApiKey: true,
        hasTrace: true,
        hasTeammate: true,
        hasGitConnection: true,
        hasRepoLinked: true,
      }),
    });
    render(<GettingStartedChecklist />);
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.title'),
    ).not.toBeInTheDocument();
  });

  it('a completed step shows no CTA link', () => {
    mockUseSWR.mockReturnValue({ data: status({ hasApiKey: true }) });
    render(<GettingStartedChecklist />);
    expect(
      screen.queryByRole('link', { name: 'dashboard.gettingStarted.checklist.apiKey.cta' }),
    ).not.toBeInTheDocument();
    // ...but the trace step (still incomplete) keeps its CTA.
    expect(
      screen.getByRole('link', { name: 'dashboard.gettingStarted.checklist.trace.cta' }),
    ).toBeInTheDocument();
  });

  it('dismiss persists to localStorage and hides the card', async () => {
    mockUseSWR.mockReturnValue({ data: status() });
    const user = userEvent.setup();
    render(<GettingStartedChecklist />);

    await user.click(screen.getByRole('button', { name: 'dismiss checklist' }));

    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
    await waitFor(() =>
      expect(
        screen.queryByText('dashboard.gettingStarted.checklist.title'),
      ).not.toBeInTheDocument(),
    );
  });

  it('stays hidden when already dismissed', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    mockUseSWR.mockReturnValue({ data: status() });
    render(<GettingStartedChecklist />);
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.title'),
    ).not.toBeInTheDocument();
  });

  it('floats as a fixed widget (out of the content flow)', () => {
    mockUseSWR.mockReturnValue({ data: status() });
    render(<GettingStartedChecklist />);
    const widget = screen.getByTestId('getting-started-widget');
    // position:fixed is what this asserts: it takes the checklist out of the
    // column flow so it doesn't displace page content. (The bottom/right
    // corner offsets are responsive sx, which jsdom's getComputedStyle doesn't
    // resolve, so they aren't asserted here.)
    expect(getComputedStyle(widget).position).toBe('fixed');
  });

  it('collapses to a pill on the collapse control, hiding the step rows, and persists it', async () => {
    mockUseSWR.mockReturnValue({ data: status() });
    const user = userEvent.setup();
    render(<GettingStartedChecklist />);

    // Expanded first: a step row is visible.
    expect(
      screen.getByText('dashboard.gettingStarted.checklist.app.label'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'collapse checklist' }));

    // Pill: compact summary present, step rows gone.
    expect(screen.getByText('Setup · 1/5')).toBeInTheDocument();
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.app.label'),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('1');
  });

  it('starts as a pill when persisted collapsed, and expands on click', async () => {
    localStorage.setItem(COLLAPSED_KEY, '1');
    mockUseSWR.mockReturnValue({ data: status() });
    const user = userEvent.setup();
    render(<GettingStartedChecklist />);

    // Pill first — no step rows.
    expect(screen.getByText('Setup · 1/5')).toBeInTheDocument();
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.app.label'),
    ).not.toBeInTheDocument();

    // Clicking the pill expands back to the full card and clears the flag.
    await user.click(screen.getByText('Setup · 1/5'));
    expect(
      screen.getByText('dashboard.gettingStarted.checklist.app.label'),
    ).toBeInTheDocument();
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0');
  });

  it('stays hidden until the first trace lands, then appears', () => {
    // Before any trace: trace-family pages render nothing (see
    // `useSetupGate`), so the checklist must NOT render even with valid data
    // and an app.
    traceRef.current = false;
    mockUseSWR.mockReturnValue({ data: status() });
    const { rerender } = render(<GettingStartedChecklist />);
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.title'),
    ).not.toBeInTheDocument();

    // Once a trace exists, the panel steps aside and the checklist takes over.
    traceRef.current = true;
    rerender(<GettingStartedChecklist />);
    expect(
      screen.getByText('dashboard.gettingStarted.checklist.title'),
    ).toBeInTheDocument();
  });

  it('renders nothing when there is no app or no data', () => {
    appRef.current = null;
    mockUseSWR.mockReturnValue({ data: undefined });
    const { rerender } = render(<GettingStartedChecklist />);
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.title'),
    ).not.toBeInTheDocument();

    appRef.current = { id: 'app-1' };
    mockUseSWR.mockReturnValue({ data: undefined });
    rerender(<GettingStartedChecklist />);
    expect(
      screen.queryByText('dashboard.gettingStarted.checklist.title'),
    ).not.toBeInTheDocument();
  });

  // The swr mock above never invokes the fetcher, so cover it directly: grab the
  // fetcher the component handed to useSWR and exercise its ok / non-ok paths.
  describe('checklist fetcher', () => {
    function captureFetcher() {
      mockUseSWR.mockReturnValue({ data: undefined });
      render(<GettingStartedChecklist />);
      const fetcher = mockUseSWR.mock.calls.at(-1)?.[1] as (u: string) => Promise<unknown>;
      expect(typeof fetcher).toBe('function');
      return fetcher;
    }

    afterEach(() => vi.unstubAllGlobals());

    it('parses the JSON body on a 200', async () => {
      const body = status({ hasApiKey: true });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
      );
      await expect(captureFetcher()('/api/orgs/org/apps/app-1/onboarding/checklist?appId=app-1')).resolves.toEqual(
        body,
      );
    });

    it('throws with the status code on a non-ok response (so SWR surfaces the error)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
      );
      await expect(captureFetcher()('/api/orgs/org/apps/app-1/onboarding/checklist?appId=app-1')).rejects.toThrow(
        '503',
      );
    });
  });
});
