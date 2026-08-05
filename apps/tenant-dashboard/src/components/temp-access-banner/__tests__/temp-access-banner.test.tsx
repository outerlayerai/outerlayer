// @vitest-environment jsdom
/**
 * Behavior-pinning for TempAccessIndicator across popover-body restyles: the
 * countdown renders as a tinted mono strip and the button copy uses sentence
 * case, but the fragile fetch/revoke wiring must be preserved, so this pins:
 *   - the chip + popover render only for a platform admin with a live grant;
 *   - Exit revokes with the fetched grantId and, on success, routes to the
 *     platform-admin organizations page;
 *   - the pending state swaps the label to "Revoking..." and disables the button;
 *   - a non-platform-admin renders nothing (fail-closed).
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const state = vi.hoisted(() => ({ isPlatformAdmin: true }));
const spies = vi.hoisted(() => ({
  push: vi.fn(),
  getStatus: vi.fn(),
  revoke: vi.fn(async () => ({ error: null }) as { error: unknown }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: spies.push }),
  useParams: () => ({ orgName: 'acme' }),
}));

vi.mock('../../../auth/hooks/use-memberships', () => ({
  useMemberships: () => ({ getMembershipByOrgName: () => ({ tenant_id: 't1' }) }),
}));

vi.mock('../../../auth/hooks/use-platform-admin', () => ({
  usePlatformAdmin: () => ({ isPlatformAdmin: state.isPlatformAdmin }),
}));

vi.mock('@/features/org-lifecycle/action-adapters', () => ({
  getTempAccessStatusAction: spies.getStatus,
}));

vi.mock('../../../sections/platform-admin/temp-access/actions', () => ({
  revokeTempAccess: spies.revoke,
}));

vi.mock('../../../routes/paths', () => ({
  paths: { platformAdmin: { organizations: '/platform-admin/organizations' } },
}));

import { TempAccessIndicator } from '../temp-access-banner';

function grantStatus() {
  return {
    data: {
      hasAccess: true,
      grantId: 'g1',
      organizationName: 'Acme Corp',
      expiresAt: new Date(Date.now() + 45 * 60000).toISOString(),
      timeRemainingMinutes: 45,
    },
  };
}

async function renderIndicator() {
  await act(async () => {
    render(<TempAccessIndicator />);
  });
}

beforeEach(() => {
  spies.push.mockClear();
  spies.revoke.mockClear();
  spies.getStatus.mockReset();
  spies.getStatus.mockResolvedValue(grantStatus());
  spies.revoke.mockResolvedValue({ error: null });
  state.isPlatformAdmin = true;
});

describe('TempAccessIndicator rendering', () => {
  it('shows the chip and popover details for a platform admin with a live grant', async () => {
    await renderIndicator();

    const chip = await screen.findByText(/Temp access/);
    fireEvent.click(chip);

    expect(screen.getByText('Temporary Access Active')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText(/Expires in 45m/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Exit customer org/i }),
    ).toBeInTheDocument();
  });

  it('renders nothing when the viewer is not a platform admin', async () => {
    state.isPlatformAdmin = false;
    await renderIndicator();

    expect(screen.queryByText(/Temp access/)).toBeNull();
  });
});

describe('TempAccessIndicator revoke', () => {
  it('revokes with the fetched grantId and routes to the organizations page on success', async () => {
    await renderIndicator();

    fireEvent.click(await screen.findByText(/Temp access/));
    fireEvent.click(screen.getByRole('button', { name: /Exit customer org/i }));

    await waitFor(() => expect(spies.revoke).toHaveBeenCalledWith({ grantId: 'g1' }));
    await waitFor(() =>
      expect(spies.push).toHaveBeenCalledWith('/platform-admin/organizations'),
    );
  });

  it('swaps the label to "Revoking..." and disables the button while pending', async () => {
    spies.revoke.mockImplementationOnce(() => new Promise(() => {}));
    await renderIndicator();

    fireEvent.click(await screen.findByText(/Temp access/));
    fireEvent.click(screen.getByRole('button', { name: /Exit customer org/i }));

    const revoking = await screen.findByRole('button', { name: /Revoking/i });
    expect(revoking).toBeDisabled();
    expect(spies.push).not.toHaveBeenCalled();
  });
});
