// @vitest-environment jsdom
/**
 * Tests for the UpgradePrompt component.
 *
 * Test data is inlined so no test depends on a fixture defined elsewhere.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { UpgradePrompt } from './upgrade-prompt';
import type { EntitlementDeniedInfo } from '@/config/entitlements';

vi.mock('next/navigation', () => ({
  usePathname: () => '/orgs/test-org/apps',
  useParams: () => ({ orgName: 'test-org' }),
}));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function selfServeInfo(overrides?: Partial<EntitlementDeniedInfo>): EntitlementDeniedInfo {
  return {
    featureKey: 'max_apps',
    featureDisplayName: 'Multiple Apps',
    requiredTier: 'growth',
    requiredTierDisplayName: 'Growth',
    isSelfServe: true,
    pricing: '$24/user/month',
    upgradeUrl: '/settings/billing',
    currentLimit: 1,
    requiredTierLimit: 10,
    ...overrides,
  };
}

function enterpriseInfo(overrides?: Partial<EntitlementDeniedInfo>): EntitlementDeniedInfo {
  return {
    featureKey: 'custom_sso',
    featureDisplayName: 'Single Sign-On (SSO)',
    requiredTier: 'enterprise',
    requiredTierDisplayName: 'Enterprise',
    isSelfServe: false,
    pricing: null,
    upgradeUrl: '/contact',
    currentLimit: null,
    requiredTierLimit: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpgradePrompt', () => {
  describe('inline variant', () => {
    it('should show the feature display name', () => {
      render(<UpgradePrompt info={selfServeInfo()} variant="inline" />);
      expect(screen.getByText(/Multiple Apps/)).toBeInTheDocument();
    });

    it('should show generic upgrade message for self-serve tiers', () => {
      render(<UpgradePrompt info={selfServeInfo()} variant="inline" />);
      expect(screen.getByText(/Upgrade your plan to unlock/)).toBeInTheDocument();
    });

    it('should resolve billing URL with org context and returnTo param', () => {
      render(<UpgradePrompt info={selfServeInfo()} variant="inline" />);
      expect(screen.getByRole('link', { name: /upgrade plan/i })).toHaveAttribute(
        'href',
        '/orgs/test-org/settings/billing?returnTo=%2Forgs%2Ftest-org%2Fapps',
      );
    });
  });

  describe('banner variant', () => {
    it('should render the feature name as title', () => {
      render(<UpgradePrompt info={selfServeInfo()} variant="banner" />);
      expect(screen.getByText('Multiple Apps')).toBeInTheDocument();
    });

    it('should render the generic upgrade button', () => {
      render(<UpgradePrompt info={selfServeInfo()} variant="banner" />);
      expect(screen.getByRole('link', { name: /upgrade plan/i })).toBeInTheDocument();
    });
  });

  describe('enterprise tier', () => {
    it('should show Contact Sales when tier is non-self-serve', () => {
      render(<UpgradePrompt info={enterpriseInfo()} variant="inline" />);
      expect(screen.getByRole('link', { name: /contact sales/i })).toBeInTheDocument();
    });

    it('should show plan availability copy when tier is enterprise', () => {
      render(<UpgradePrompt info={enterpriseInfo()} variant="inline" />);
      expect(
        screen.getByText(/available on the Enterprise plan/),
      ).toBeInTheDocument();
    });
  });
});
