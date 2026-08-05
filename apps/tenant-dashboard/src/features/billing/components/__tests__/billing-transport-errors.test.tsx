// @vitest-environment jsdom
/**
 * Billing leaf-component transport-error + result handling.
 *
 * Server actions invoked from the client reject at the *transport* level when
 * the POST response is not a parseable Flight payload — Next.js throws
 * "An unexpected response was received from the server." This happens with
 * deployment version skew, proxies/extensions mangling the response, and in
 * E2E runs where the action POST is stubbed (see
 * apps/e2e/tests/billing/setup.spec.ts interceptServerAction).
 *
 * The `result.ok` checks in the callers only cover *application*-level
 * failures the action returned; a transport rejection bypasses them (the
 * awaited call throws instead of resolving). Each caller must catch the
 * rejection and surface a snackbar — otherwise it becomes an unhandled
 * rejection (production Sentry: "An unexpected response was received from
 * the server." on /settings/billing).
 *
 * Bug class caught: removing the try/catch around a billing server-action
 * call site reintroduces the unhandled rejection and fails these tests.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { enqueueSnackbarSpy, actionMocks } = vi.hoisted(() => ({
  enqueueSnackbarSpy: vi.fn(),
  actionMocks: {
    createPortalSession: vi.fn(),
    createCheckoutSession: vi.fn(),
    upgradeSubscription: vi.fn(),
  },
}));

vi.mock('../../actions', () => actionMocks);

// billing-management uses useSnackbar(); billing-setup uses the named
// enqueueSnackbar export.
vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarSpy }),
  enqueueSnackbar: enqueueSnackbarSpy,
}));

vi.mock('@/lib/app-shell/use-current-user', () => ({
  useCurrentUser: () => ({ role: 'owner' }),
  UserRoleEnum: { OWNER: 'owner', ADMIN: 'admin' },
}));

vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: () => <span data-testid="iconify" />,
}));

vi.mock('../upgrade-confirmation-dialog', () => ({
  UpgradeConfirmationDialog: () => null,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
}));

import BillingManagement from '../billing-management';
import BillingSetup from '../billing-setup';

/** The exact transport error Next.js throws for a non-Flight action response. */
const transportError = () =>
  new Error('An unexpected response was received from the server.');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('billing server-action transport errors', () => {
  it('should show an error snackbar when createPortalSession rejects at the transport level', async () => {
    actionMocks.createPortalSession.mockRejectedValue(transportError());

    render(
      <BillingManagement
        usage={0}
        storageGb={0}
        tierId="growth"
        tierDisplayName="Growth"
        isCancelling={false}
      />,
    );

    await userEvent.click(
      screen.getByText('dashboard.settings.billing.management.managePlanLink'),
    );

    await waitFor(() => {
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith('Failed to open billing portal', {
        variant: 'error',
      });
    });
  });

  it('should show an error snackbar when createCheckoutSession rejects at the transport level', async () => {
    actionMocks.createCheckoutSession.mockRejectedValue(transportError());

    render(<BillingSetup usage={0} storageGb={0} />);

    await userEvent.click(
      screen.getByText('dashboard.settings.billing.setup.standardPlan'),
    );

    await waitFor(() => {
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith('Failed to start checkout', {
        variant: 'error',
      });
    });
  });
});

describe('manageBilling result handling', () => {
  const renderManagement = () =>
    render(
      <BillingManagement
        usage={0}
        storageGb={0}
        tierId="growth"
        tierDisplayName="Growth"
        isCancelling={false}
      />,
    );
  const clickManage = () =>
    userEvent.click(
      screen.getByText('dashboard.settings.billing.management.managePlanLink'),
    );

  it('should surface the action-provided error message when createPortalSession returns a typed failure', async () => {
    actionMocks.createPortalSession.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'Portal exploded' },
    });

    renderManagement();
    await clickManage();

    await waitFor(() => {
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith('Portal exploded', {
        variant: 'error',
      });
    });
  });

  it('should not show any snackbar when createPortalSession returns a portal URL', async () => {
    actionMocks.createPortalSession.mockResolvedValue({
      ok: true,
      data: 'https://billing.stripe.com/session/test_123',
    });

    renderManagement();
    await clickManage();

    await waitFor(() => {
      expect(actionMocks.createPortalSession).toHaveBeenCalledWith({
        redirectTo: window.location.href,
      });
    });
    // Flush the remainder of manageBilling (window.location.assign is a
    // jsdom no-op) before asserting the success path stayed silent.
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueueSnackbarSpy).not.toHaveBeenCalled();
  });
});

describe('billingSignup result handling', () => {
  const clickGrowthCard = () =>
    userEvent.click(screen.getByText('dashboard.settings.billing.setup.standardPlan'));

  it('should surface the action-provided error message when createCheckoutSession returns a typed failure', async () => {
    actionMocks.createCheckoutSession.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'Checkout exploded' },
    });

    render(<BillingSetup usage={0} storageGb={0} />);
    await clickGrowthCard();

    await waitFor(() => {
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith('Checkout exploded', {
        variant: 'error',
      });
    });
  });

  it('should not show any snackbar when createCheckoutSession returns a checkout URL', async () => {
    actionMocks.createCheckoutSession.mockResolvedValue({
      ok: true,
      data: 'https://checkout.stripe.com/session/test_456',
    });

    render(<BillingSetup usage={0} storageGb={0} />);
    await clickGrowthCard();

    await waitFor(() => {
      expect(actionMocks.createCheckoutSession).toHaveBeenCalledWith({
        redirectTo: window.location.href,
        tierId: 'growth',
      });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueueSnackbarSpy).not.toHaveBeenCalled();
  });
});

describe('enterprise contact', () => {
  // The enterprise tier has no self-serve checkout: both views must hand the
  // user to the public sales contact in a new tab and must NOT start a Stripe
  // flow. Pinning the exact mailto URL catches a mangled or non-public
  // contact address; the not-called assertions catch the enterprise card
  // falling through into the checkout/upgrade paths.
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it('opens the sales mailto in a new tab from the setup view instead of starting a checkout', async () => {
    render(<BillingSetup usage={0} storageGb={0} />);

    await userEvent.click(
      screen.getByText('dashboard.settings.billing.setup.enterprisePlan'),
    );

    expect(openSpy).toHaveBeenCalledWith(
      'mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise',
      '_blank',
    );
    expect(actionMocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('opens the sales mailto in a new tab from the management upgrade card instead of an upgrade', async () => {
    render(
      <BillingManagement
        usage={0}
        storageGb={0}
        tierId="growth"
        tierDisplayName="Growth"
        isCancelling={false}
      />,
    );

    await userEvent.click(screen.getByText('Enterprise'));

    expect(openSpy).toHaveBeenCalledWith(
      'mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise',
      '_blank',
    );
    expect(actionMocks.upgradeSubscription).not.toHaveBeenCalled();
    expect(actionMocks.createCheckoutSession).not.toHaveBeenCalled();
  });
});
