/* consumed by stryker CLI — SCOPED money-and-auth mutation run */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dedicated high-floor scope: the dashboard's money-and-auth core (Stripe
// checkout/portal/upgrade server actions + the payment webhook) carries the
// highest blast radius in the app, so it is held to the gateway/builder bar
// rather than the lax global tenant-dashboard floor (which broad UI/server
// mutants justify). Floor is ratchet-managed under the suffixed key below;
// null disables the break check while a baseline is established.
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['apps/tenant-dashboard:money-auth'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.stryker-money-auth.config.ts',
    related: false,
  },
  // inPlace skips the sandbox copy (see stryker.config.mjs for the rationale —
  // vitest.config.ts imports a monorepo-root alias file Stryker won't sandbox).
  inPlace: true,
  coverageAnalysis: 'perTest',
  checkers: [],

  incremental: true,
  incrementalFile: 'reports/mutation/stryker-money-auth-incremental.json',
  ignoreStatic: true,
  mutator: {
    excludedMutations: ['StringLiteral', 'Regex', 'BlockStatement'],
  },

  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {
    fileName: 'reports/mutation/money-auth/index.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/money-auth.json',
  },
  timeoutMS: 30000,
  dryRunTimeoutMinutes: 10,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },
  // The money-and-auth surface. Keep in sync with SCOPED_FLOORS in
  // scripts/ci/patch-mutation.mjs — that array is the PR-time enforcement
  // source of truth; this config is the manual `test:mutate:money-auth` runner.
  // stripe-prices.ts computes Stripe checkout line items + subscription
  // swap/delete sets, so a silent bug mis-bills customers — it earns the 85 bar.
  // The billing slice is split across two files, and both are money-and-auth
  // core: `features/billing/actions.ts` carries the permission gates
  // (`billing.insert`/`billing.update`/`billing.read`) and
  // `features/billing/service.ts` carries the Stripe calls and RLS-scoped
  // reads those actions delegate to. Mutating only the action wrapper would
  // leave the half that touches Stripe unguarded.
  mutate: [
    'src/features/billing/actions.ts',
    'src/features/billing/service.ts',
    'src/app/api/webhooks/payment/route.ts',
    'src/config/stripe-prices.ts',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
    '!src/**/*.d.ts',
  ],
};

export default config;
