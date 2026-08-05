/**
 * Stripe test-mode helpers for the billing plan-lifecycle e2e.
 *
 * These talk to the REAL Stripe test account via the `stripe` CLI, so the
 * billing spec exercises the real subscription objects + the real webhook
 * (delivered to the dashboard by `stripe listen` locally, or by Stripe's public
 * endpoint on staging). They deliberately do NOT drive Stripe's hosted Checkout
 * / Billing Portal DOM — Stripe owns and changes those pages, so automating
 * them is chronically flaky (Stripe's own guidance is to use the test API +
 * webhooks instead). The one inherently-hosted step (first subscribe) is seeded
 * via the API; the upgrade is driven through our own first-party dialog.
 *
 * Auth: pass the test secret key via STRIPE_TEST_SECRET_KEY (or STRIPE_SECRET_KEY).
 * We use `--api-key` rather than relying on an interactive `stripe login`
 * session, so the spec is reproducible in CI / by other devs. execFile (no
 * shell) keeps the dynamically-built args injection-safe.
 */
import { execFileSync } from 'node:child_process';

function stripeKey(): string {
  const key = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith('sk_test_')) {
    throw new Error(
      'billing-live specs require a TEST-mode secret key in STRIPE_TEST_SECRET_KEY ' +
        '(or STRIPE_SECRET_KEY). Refusing to run without sk_test_* (never drive live billing).',
    );
  }
  return key;
}

/** Run a `stripe` CLI subcommand and parse its JSON. No shell → args are literal. */
function stripe<T = Record<string, unknown>>(args: string[]): T {
  const out = execFileSync('stripe', [...args, '--api-key', stripeKey()], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return (out.trim() ? JSON.parse(out) : {}) as T;
}

/**
 * Run a destructive `stripe` command (cancel/delete). These need `--confirm`
 * (the CLI otherwise prompts interactively, which EOFs under execFile) and they
 * print a human "This command will be executed…" preamble to stdout, so we
 * ignore stdout rather than parse it. A non-zero exit still throws.
 */
function stripeVoid(args: string[]): void {
  execFileSync('stripe', [...args, '--confirm', '--api-key', stripeKey()], {
    timeout: 30_000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export function hasStripeTestKey(): boolean {
  const key = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  return !!key && key.startsWith('sk_test_');
}

/**
 * Create a real test-mode customer with a default test card attached. A
 * subscription can't be created (and checkout can't run) against the fake
 * `cus_test_*` id that createTestBillingRecord seeds, so the billing row's
 * customer must be replaced with this real one.
 */
export function createTestStripeCustomer(email: string): { id: string } {
  const customer = stripe<{ id: string }>(['customers', 'create', '--email', email]);
  const pm = stripe<{ id: string }>([
    'payment_methods', 'attach', 'pm_card_visa', '--customer', customer.id,
  ]);
  stripe([
    'customers', 'update', customer.id,
    '-d', `invoice_settings[default_payment_method]=${pm.id}`,
  ]);
  return { id: customer.id };
}

/** Create an active subscription on a flat (licensed) price → fires
 *  customer.subscription.created, which the dashboard webhook maps to a tier. */
export function createTestSubscription(customerId: string, priceId: string): { id: string; status: string } {
  const sub = stripe<{ id: string; status: string }>([
    'subscriptions', 'create', '--customer', customerId,
    '-d', `items[0][price]=${priceId}`,
  ]);
  return { id: sub.id, status: sub.status };
}

/** Cancel immediately → fires customer.subscription.deleted (revert to hobby). */
export function cancelTestSubscription(subId: string | null): void {
  if (!subId) return;
  try {
    stripeVoid(['subscriptions', 'cancel', subId]);
  } catch (e) {
    console.warn(`[E2E] cancelTestSubscription(${subId}) failed:`, (e as Error).message);
  }
}

export function deleteTestStripeCustomer(customerId: string | null): void {
  if (!customerId) return;
  try {
    stripeVoid(['customers', 'delete', customerId]);
  } catch (e) {
    console.warn(`[E2E] deleteTestStripeCustomer(${customerId}) failed:`, (e as Error).message);
  }
}
