import { describe, expect, it } from 'vitest';
import { resolveBillingConfig } from './billing-config';

describe('resolveBillingConfig', () => {
  it('is enabled by default when nothing is set (opt-out: hosted keeps Stripe)', () => {
    expect(resolveBillingConfig({})).toEqual({ enabled: true });
  });

  it('stays enabled when BILLING_ENABLED is explicitly truthy', () => {
    expect(resolveBillingConfig({ BILLING_ENABLED: 'true' })).toEqual({ enabled: true });
  });

  it('disables only when BILLING_ENABLED is explicitly falsy', () => {
    expect(resolveBillingConfig({ BILLING_ENABLED: 'false' })).toEqual({ enabled: false });
  });

  it.each(['false', '0', 'no', 'off', 'OFF'])(
    'treats %j as disabled',
    (raw) => {
      expect(resolveBillingConfig({ BILLING_ENABLED: raw }).enabled).toBe(false);
    },
  );

  it.each(['true', '1', 'yes', 'on', 'TRUE'])(
    'treats %j as enabled',
    (raw) => {
      expect(resolveBillingConfig({ BILLING_ENABLED: raw }).enabled).toBe(true);
    },
  );

  it('defaults to enabled for an unrecognised value (fails safe toward hosted)', () => {
    expect(resolveBillingConfig({ BILLING_ENABLED: 'maybe' }).enabled).toBe(true);
  });
});
