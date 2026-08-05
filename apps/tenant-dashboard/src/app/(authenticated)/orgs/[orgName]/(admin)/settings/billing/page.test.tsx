import { describe, it, expect, vi, beforeEach } from 'vitest';

// notFound() halts rendering by throwing in Next; mimic that so the disabled
// path is observable.
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// Avoid pulling the heavy MUI Billing tree (and its React Server Component (RSC) data read) into the test.
vi.mock('@/features/billing', () => ({
  BillingPage: () => 'BILLING_PAGE',
}));

// BILLING_ENABLED as a mutable getter so both branches are exercised.
const cfg = vi.hoisted(() => ({ billingEnabled: 'true' }));
vi.mock('../../../../../../../config-global.server', () => ({
  get BILLING_ENABLED() {
    return cfg.billingEnabled;
  },
}));

import BillingSettingsPage from './page';
import { notFound } from 'next/navigation';

beforeEach(() => {
  cfg.billingEnabled = 'true';
  (notFound as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('BillingSettingsPage — billing gate', () => {
  it('renders the billing page when billing is enabled', () => {
    cfg.billingEnabled = 'true';
    const el = BillingSettingsPage();
    expect(notFound).not.toHaveBeenCalled();
    expect((el as { type: () => string }).type()).toBe('BILLING_PAGE');
  });

  it('calls notFound() (404) when billing is disabled (self-hosting)', () => {
    cfg.billingEnabled = 'false';
    expect(() => BillingSettingsPage()).toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
