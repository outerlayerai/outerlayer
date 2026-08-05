/**
 * Pins the sensitive-path boundary of the patch-coverage gate.
 *
 * The matcher exists for security/money LOGIC (webhook signatures, auth
 * wrappers, billing math). A directory merely NAMED `auth` is not enough:
 * src/layouts/auth/ is brand chrome — the branded login panel — and must
 * not inherit webhook-grade thresholds (a directory-name false positive
 * would otherwise apply them to a marketing panel).
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs module without type declarations
import { isSensitive } from '../ci/check-patch-coverage.mjs';

describe('isSensitive', () => {
  it.each([
    // Auth LOGIC — sensitive
    'apps/tenant-dashboard/src/app/auth/login/page.tsx',
    'apps/tenant-dashboard/src/auth/guard/auth-guard.tsx',
    'apps/tenant-dashboard/src/utils/supabase/middleware.ts',
    // Money + privileged surfaces — sensitive
    'apps/tenant-dashboard/src/sections/billing/actions.ts',
    'apps/tenant-dashboard/src/app/api/webhooks/stripe/route.ts',
    'apps/tenant-dashboard/src/app/api/platform-admin/dora-metrics/route.ts',
    'apps/tenant-dashboard/src/app/api/internal/dora/deployments/route.ts',
    'apps/gateway/src/middleware/verify-key.ts',
    'packages/observability-service/src/dlq-handler.ts',
  ])('treats %s as sensitive', (file) => {
    expect(isSensitive(file)).toBe(true);
  });

  it.each([
    // Auth CHROME — the branded login panel is visual composition, not an
    // authentication boundary
    'apps/tenant-dashboard/src/layouts/auth/classic.tsx',
    'apps/tenant-dashboard/src/layouts/auth/modern.tsx',
    // Ordinary product code
    'apps/tenant-dashboard/src/sections/dora-metrics/dora-metric-card.tsx',
    'apps/tenant-dashboard/src/components/logo/logo.tsx',
  ])('treats %s as NOT sensitive', (file) => {
    expect(isSensitive(file)).toBe(false);
  });
});
