// @vitest-environment jsdom
/**
 * Tests for RepoGateBanner — the soft half of the onboarding v2 repo gate.
 * The banner must appear ONLY when traces exist but no repository is linked,
 * must never be dismissible, and must drive the same connect→link flow as
 * the setup card (via the shared `useRepoConnect` hook, which runs real
 * here — only SWR and the link modal are stubbed).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingSetupState } from "../../checklist";

const { appRef, traceRef, mockUseSWR, mockMutate, mockStartGitConnectAction } = vi.hoisted(() => ({
  appRef: { current: { id: 'app-1' } as { id: string } | null },
  traceRef: { current: true },
  mockUseSWR: vi.fn(),
  mockMutate: vi.fn(),
  mockStartGitConnectAction: vi.fn(),
}));

// The global unit-test setup stubs useBoolean to a dead `{ value: false }` —
// fine for tests that don't care, fatal here: the banner's link modal can
// only open through it. Restore the real hook for this file.
vi.mock('@/hooks/use-boolean', async (importOriginal) =>
  importOriginal<typeof import('@/hooks/use-boolean')>(),
);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => ({ app: appRef.current, hasCreatedTrace: traceRef.current }),
}));
vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar: vi.fn() }),
}));
vi.mock('swr', () => ({ default: (...args: unknown[]) => mockUseSWR(...args) }));
vi.mock('@/lib/git-connect/start-git-connect-action', () => ({
  startGitConnectAction: (...args: unknown[]) => mockStartGitConnectAction(...args),
}));
vi.mock('@/components/link-repository', () => ({
  LinkRepositoryModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="link-repository-modal">
        <button type="button" onClick={onClose}>
          close-link-modal
        </button>
      </div>
    ) : null,
}));

import { RepoGateBanner } from "../repo-gate-banner";

const setupState = (s: Partial<OnboardingSetupState> = {}): OnboardingSetupState => ({
  hasApiKey: false,
  hasTrace: true,
  hasTeammate: false,
  hasGitConnection: false,
  hasRepoLinked: false,
  provider: null,
  ...s,
});

const BANNER_TEXT = 'dashboard.gettingStarted.banner.message';
const CTA = 'dashboard.gettingStarted.banner.cta';

beforeEach(() => {
  vi.clearAllMocks();
  appRef.current = { id: 'app-1' };
  traceRef.current = true;
  mockUseSWR.mockReturnValue({ data: setupState(), mutate: mockMutate });
});

describe('RepoGateBanner', () => {
  it('renders the persistent nudge when traces exist but no repo is linked — with no dismiss control', () => {
    render(<RepoGateBanner />);
    expect(screen.getByText(BANNER_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CTA })).toBeInTheDocument();
    // Soft-required means persistent: MUI Alert would render a close button
    // only if we passed onClose — pin that we never do.
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('stays hidden before the first trace (the setup card owns that phase)', () => {
    traceRef.current = false;
    render(<RepoGateBanner />);
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });

  it('stays hidden while setup state is unknown and once the repo is linked', () => {
    mockUseSWR.mockReturnValue({ data: undefined, mutate: mockMutate });
    const { rerender } = render(<RepoGateBanner />);
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();

    mockUseSWR.mockReturnValue({
      data: setupState({ hasGitConnection: true, hasRepoLinked: true }),
      mutate: mockMutate,
    });
    rerender(<RepoGateBanner />);
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });

  it('CTA starts the GitHub connect flow when nothing is connected', async () => {
    mockStartGitConnectAction.mockResolvedValue({
      ok: true,
      data: { ok: true, authorizationUrl: 'https://example.test/authorize' },
    });
    const user = userEvent.setup();
    render(<RepoGateBanner />);
    await user.click(screen.getByRole('button', { name: CTA }));
    expect(mockStartGitConnectAction).toHaveBeenCalledWith({
      appId: 'app-1',
      provider: 'github',
    });
    expect(screen.queryByTestId('link-repository-modal')).toBeNull();
  });

  it('CTA opens the link-repository modal once connected, and closing it revalidates', async () => {
    const user = userEvent.setup();
    mockUseSWR.mockReturnValue({
      data: setupState({ hasGitConnection: true }),
      mutate: mockMutate,
    });
    render(<RepoGateBanner />);

    await user.click(screen.getByRole('button', { name: CTA }));
    expect(screen.getByTestId('link-repository-modal')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'close-link-modal' }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });
});