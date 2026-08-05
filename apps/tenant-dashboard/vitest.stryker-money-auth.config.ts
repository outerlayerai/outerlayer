/* eslint-disable import/no-unused-modules -- Loaded by vitest/stryker at runtime, not via static import */
import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config for the SCOPED money-and-auth Stryker run.
 *
 * Narrows test discovery to just the suites that exercise the mutated
 * money-and-auth modules (the billing feature slice's actions + service, and
 * the Stripe payment webhook). A full-suite dry run is unnecessary here —
 * Stryker only needs the tests covering `stryker.config.money-auth.mjs`'s
 * `mutate` set, and scoping discovery keeps the dry run to seconds instead of
 * minutes.
 *
 * NOTE: `mergeConfig` concatenates arrays, so we cannot merge `include` (it
 * would append to the base `src/**` glob and run the whole suite — which also
 * drags in the schema-drift tests that false-fail under Stryker). We override
 * the merged result's `include`/`exclude` outright below.
 */
const merged = mergeConfig(base, {});
merged.test = {
  ...merged.test,
  include: [
    'src/features/billing/actions.test.ts',
    'src/features/billing/service.test.ts',
    'src/app/api/webhooks/payment/route.test.ts',
    'src/config/stripe-prices.test.ts',
  ],
  exclude: ['**/*.helpers.ts', '**/node_modules/**'],
};

export default merged;
