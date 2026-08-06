// @vitest-environment jsdom
/**
 * AuthClassicLayout: the branded auth left panel.
 *
 * Covers the OuterLayer brand composition: the eyebrow, the evidence-layer
 * headline with the warm marker (and the per-page title override), the
 * leader-questions subhead, the session-to-PR-outcome card, and the
 * no-leaderboards badge.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import en from '../../../locales/langs/en.json';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before component import
// ---------------------------------------------------------------------------

function translate(key: string): string {
  return key.split('.').reduce<any>((acc, part) => acc?.[part], en) ?? key;
}

vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({ t: translate }),
  LocalizationProvider: ({ children }: any) => children,
  Translation: ({ i18nKey }: any) => <span>{translate(i18nKey)}</span>,
}));

vi.mock('@/components/logo', () => ({
  __esModule: true,
  default: () => <div data-testid="logo" />,
}));

vi.mock('../../../hooks/use-responsive', () => ({
  useResponsive: vi.fn(),
}));

import { useResponsive } from '../../../hooks/use-responsive';

import AuthClassicLayout from '../classic';

const mockedUseResponsive = vi.mocked(useResponsive);

function wrap(ui: React.ReactElement, mode: 'light' | 'dark' = 'light') {
  // The outcome line reads success.main; provide a known hue so the style
  // assertions pin an exact value.
  const theme = createTheme({
    palette: {
      mode,
      success: { main: '#22c55e' } as any,
    },
  });
  return render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}

beforeEach(() => {
  mockedUseResponsive.mockReturnValue(true); // md-up by default
});

describe('AuthClassicLayout', () => {
  it('renders the brand panel on md-up: eyebrow, headline, subhead, badge, and children', () => {
    wrap(
      <AuthClassicLayout>
        <div data-testid="form">form</div>
      </AuthClassicLayout>,
    );

    // Eyebrow (uppercased via CSS; the DOM keeps the sentence-case string)
    expect(
      screen.getByText('Open source · agentic engineering'),
    ).toBeInTheDocument();

    // Default headline, split across spans — assert the full sentence
    expect(
      screen.getByText((_, el) =>
        el?.tagName === 'P' &&
        el.textContent === 'The evidence layer for coding agents.',
      ),
    ).toBeInTheDocument();

    // Subhead: the three leader questions, then the mechanism
    expect(
      screen.getByText(
        'Shipping faster? Worth the spend? Ready for more autonomy?',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Outerlayer answers from evidence: every session tied to how its code held up.',
      ),
    ).toBeInTheDocument();

    // Trust badge
    expect(
      screen.getByText('No per-developer leaderboards. Ever.'),
    ).toBeInTheDocument();

    // The form children still render
    expect(screen.getByTestId('form')).toBeInTheDocument();
  });

  it('renders the evidence-loop card: distillation, top pattern, cost, measured fix', () => {
    wrap(<AuthClassicLayout>x</AuthClassicLayout>);

    expect(screen.getByText('▣ outerlayer')).toBeInTheDocument();

    // Each line's segments live in separate nodes — assert full lines via
    // their containers so drops and reorders fail loudly
    const lines = [
      '416 sessions this week · 3 worth your attention',
      '#1 agents pass --no-verify when pre-push fails',
      '   41 sessions · $184 rework · 2 reverts',
      '   fix shipped to CLAUDE.md · repeat rate 31% → 4%',
    ];
    for (const line of lines) {
      expect(
        screen.getByText(
          (_, el) => el?.tagName === 'DIV' && el.textContent === line,
        ),
      ).toBeInTheDocument();
    }

    // The measured proof reads as the win
    expect(screen.getByText('repeat rate 31% → 4%')).toHaveStyle({
      color: 'rgb(34, 197, 94)', // success.main
    });
  });

  it('replaces the default headline with the translated page title when given', () => {
    wrap(
      <AuthClassicLayout title="auth.acceptInvite.welcomeTitle">x</AuthClassicLayout>,
    );

    expect(screen.getByText('Join your team on OuterLayer')).toBeInTheDocument();
    expect(screen.queryByText('evidence layer')).toBeNull();
  });

  it('omits the brand panel entirely below md', () => {
    mockedUseResponsive.mockReturnValue(false);

    wrap(
      <AuthClassicLayout>
        <div data-testid="form">form</div>
      </AuthClassicLayout>,
    );

    expect(screen.queryByText('▣ outerlayer')).toBeNull();
    expect(screen.queryByText(/evidence layer/)).toBeNull();
    expect(screen.getByTestId('form')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Style pinning — the marker is pinned hex BY DESIGN: a highlighter must
  // not re-ink in dark mode, so the exact values are behavior, not
  // decoration. If these fail, someone routed the marker through theme vars.
  // -------------------------------------------------------------------------

  it('pins the warm marker to its hex in light mode', () => {
    wrap(<AuthClassicLayout>x</AuthClassicLayout>, 'light');

    expect(screen.getByText('evidence layer')).toHaveStyle({
      backgroundColor: 'rgb(255, 152, 0)', // #FF9800
      color: 'rgb(26, 26, 24)', // #1A1A18
    });
  });

  it('keeps the marker identical in dark mode (no theme re-ink)', () => {
    wrap(<AuthClassicLayout>x</AuthClassicLayout>, 'dark');

    expect(screen.getByText('evidence layer')).toHaveStyle({
      backgroundColor: 'rgb(255, 152, 0)',
      color: 'rgb(26, 26, 24)',
    });
  });
});
