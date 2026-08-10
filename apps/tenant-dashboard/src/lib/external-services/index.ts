import "server-only";

import Stripe from "stripe";
import { Ratelimit } from "@unkey/ratelimit";
import type { Resend as ResendClient } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import { render } from "@react-email/render";
import {
  STRIPE_SECRET_KEY,
  BILLING_ENABLED,
  UNKEY_API_KEY,
  RESEND_API_KEY,
  RESEND_BROADCAST_AUDIENCE_ID,
  FROM_EMAIL,
  REPLY_TO_EMAIL,
  EMAIL_ENABLED,
  EMAIL_PROVIDER,
  EMAIL_RECIPIENT_ALLOWLIST,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
} from "../../config-global.server";
import { InviteEmail, BuildFailureEmail, RoleChangedEmail, RemovedFromOrgEmail, TempAccessNotificationEmail } from "@repo/transactional";
import { EmailType } from "../../utils/email";
import { resolveEmailConfig, resolveRecipientAllowlist } from "./email-config";
import { isEmailAllowed } from "../email-allowlist";
import { resolveBillingConfig } from "./billing-config";

export interface StripeService {
  createCustomer(params: {
    name: string;
    email: string;
    metadata: Record<string, string>;
  }, options: { idempotencyKey: string }): Promise<Stripe.Customer>;
  retrieveCustomer(customerId: string): Promise<Stripe.Customer>;
  deleteCustomer(customerId: string): Promise<void>;
  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription>;
  updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams
  ): Promise<Stripe.Subscription>;
}

/**
 * The full billing surface. Superset of {@link StripeService} (org-creation only
 * needs the narrow customer ops) that also covers the dashboard's checkout,
 * billing-portal, usage-meter, and webhook-verification calls. Every Stripe call
 * in the dashboard goes through this seam so {@link createBillingService} is the
 * single place that decides real-Stripe vs. the no-op {@link MockBillingService}
 * (self-hosting with `BILLING_ENABLED=false`).
 */
export interface BillingService extends StripeService {
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams
  ): Promise<Stripe.Checkout.Session>;
  createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams
  ): Promise<Stripe.BillingPortal.Session>;
  listMeterEventSummaries(
    meterId: string,
    params: Stripe.Billing.MeterListEventSummariesParams
  ): Promise<Stripe.ApiList<Stripe.Billing.MeterEventSummary>>;
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    secret: string
  ): Stripe.Event;
}

// Pinned to the SDK's own API version: stripe's types are generated for
// exactly this version, so pinning anything else makes the response types lie.
const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;

// Default implementations for dependency injection
export class DefaultStripeService implements StripeService {
  protected stripe: Stripe;

  constructor() {
    // STRIPE_SECRET_KEY is exported as "" when unset (config-global coerces the
    // now-optional env to a string). This service is only ever constructed on the
    // billing-enabled path — createBillingService() wires MockBillingService when
    // billing is off — so an empty key here is a real misconfiguration. Fail fast
    // with a clear message instead of letting `new Stripe("")` fail deep inside
    // the SDK at the first API call.
    if (!STRIPE_SECRET_KEY) {
      throw new Error(
        "STRIPE_SECRET_KEY is required when billing is enabled (set BILLING_ENABLED=false to self-host without Stripe).",
      );
    }
    this.stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      timeout: 10000, // 10 seconds
    });
  }

  async createCustomer(params: {
    name: string;
    email: string;
    metadata: Record<string, string>;
  }, options: { idempotencyKey: string }): Promise<Stripe.Customer> {
    return await this.stripe.customers.create(params, options);
  }

  async retrieveCustomer(customerId: string): Promise<Stripe.Customer> {
    return await this.stripe.customers.retrieve(customerId) as Stripe.Customer;
  }

  async deleteCustomer(customerId: string): Promise<void> {
    await this.stripe.customers.del(customerId);
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return await this.stripe.subscriptions.retrieve(subscriptionId);
  }

  async updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams
  ): Promise<Stripe.Subscription> {
    return await this.stripe.subscriptions.update(subscriptionId, params);
  }
}

/**
 * Real billing backend: the full {@link BillingService} over the Stripe SDK.
 * Reuses the customer/subscription ops from {@link DefaultStripeService} and
 * adds checkout, billing-portal, usage-meter, and webhook verification.
 */
export class DefaultBillingService extends DefaultStripeService implements BillingService {
  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams
  ): Promise<Stripe.Checkout.Session> {
    return await this.stripe.checkout.sessions.create(params);
  }

  async createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams
  ): Promise<Stripe.BillingPortal.Session> {
    return await this.stripe.billingPortal.sessions.create(params);
  }

  async listMeterEventSummaries(
    meterId: string,
    params: Stripe.Billing.MeterListEventSummariesParams
  ): Promise<Stripe.ApiList<Stripe.Billing.MeterEventSummary>> {
    return await this.stripe.billing.meters.listEventSummaries(meterId, params);
  }

  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    secret: string
  ): Stripe.Event {
    return this.stripe.webhooks.constructEvent(payload, signature, secret);
  }
}

/**
 * No-op billing backend wired when `BILLING_ENABLED=false` (self-hosting). The
 * dashboard's billing UI is hidden and the org-creation flow skips Stripe, so
 * none of these should be reached; they throw a clear, consistent error rather
 * than silently no-op'ing, except the read-only meter query which returns an
 * empty list so usage panels render zeros instead of erroring.
 */
const BILLING_DISABLED_ERROR =
  "Billing is disabled (BILLING_ENABLED=false). This Stripe operation is unavailable on a self-hosted instance.";

export class MockBillingService implements BillingService {
  async createCustomer(): Promise<Stripe.Customer> {
    throw new Error(BILLING_DISABLED_ERROR);
  }
  async retrieveCustomer(): Promise<Stripe.Customer> {
    throw new Error(BILLING_DISABLED_ERROR);
  }
  async deleteCustomer(): Promise<void> {
    // Rollback path: nothing was created when billing is off, so this is a no-op.
  }
  async retrieveSubscription(): Promise<Stripe.Subscription> {
    throw new Error(BILLING_DISABLED_ERROR);
  }
  async updateSubscription(): Promise<Stripe.Subscription> {
    throw new Error(BILLING_DISABLED_ERROR);
  }
  async createCheckoutSession(): Promise<Stripe.Checkout.Session> {
    throw new Error(BILLING_DISABLED_ERROR);
  }
  async createBillingPortalSession(): Promise<Stripe.BillingPortal.Session> {
    throw new Error(BILLING_DISABLED_ERROR);
  }
  async listMeterEventSummaries(): Promise<
    Stripe.ApiList<Stripe.Billing.MeterEventSummary>
  > {
    return {
      object: "list",
      data: [],
      has_more: false,
      url: "",
    } as Stripe.ApiList<Stripe.Billing.MeterEventSummary>;
  }
  constructWebhookEvent(): Stripe.Event {
    throw new Error(BILLING_DISABLED_ERROR);
  }
}

/**
 * Factory: returns the real Stripe-backed {@link DefaultBillingService} for the
 * hosted product and the no-op {@link MockBillingService} when billing is
 * disabled. The enabled decision lives in {@link resolveBillingConfig} so it is
 * unit-testable without reloading the env module. This is the ONLY place the
 * dashboard constructs a billing backend — every Stripe call routes through it.
 */
export function createBillingService(): BillingService {
  const { enabled } = resolveBillingConfig({ BILLING_ENABLED });
  return enabled ? new DefaultBillingService() : new MockBillingService();
}

// ============================================================================
// Email Service
// ============================================================================

export interface EmailParams {
  to: string;
  subject: string;
  emailType: EmailType;
  templateParams: Record<string, any>;
}

export interface EmailService {
  sendEmail(params: EmailParams): Promise<{ error: Error | null }>;
  addToBroadcastAudience(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<{ success: boolean; error?: unknown }>;
}

const getTemplate = (emailType: EmailType) => {
  switch (emailType) {
    case "invite":
      return InviteEmail;
    case "build_failure":
      return BuildFailureEmail;
    case "role_changed":
      return RoleChangedEmail;
    case "removed_from_org":
      return RemovedFromOrgEmail;
    case "temp_access_notification":
      return TempAccessNotificationEmail;
    default:
      throw new Error("Invalid email type");
  }
};

const EMAIL_SEND_TIMEOUT_MS = 10_000;

/**
 * Race an email send against a fixed timeout. Shared by every provider so the
 * timeout duration and message can't drift between Resend and SMTP. Rejects
 * with the timeout error if the send doesn't settle in time (the underlying
 * send is not aborted — same contract both providers had before).
 */
async function withSendTimeout<T>(send: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Email send timed out after 10s')),
      EMAIL_SEND_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([send, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Interpret a string env var as a boolean, accepting the common truthy spellings. */
function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export class DefaultEmailService implements EmailService {
  // Lazily import + construct the Resend SDK so it never loads on the SMTP
  // provider path — keeps Resend an optional runtime dependency for self-hosters.
  private resendPromise?: Promise<ResendClient>;

  private getResend(): Promise<ResendClient> {
    if (!this.resendPromise) {
      this.resendPromise = import("resend").then((m) => new m.Resend(RESEND_API_KEY));
    }
    return this.resendPromise;
  }

  async sendEmail(params: EmailParams): Promise<{ error: Error | null }> {
    const resend = await this.getResend();
    const result = await withSendTimeout(
      resend.emails.send({
        from: `AgentMark <${FROM_EMAIL}>`,
        replyTo: REPLY_TO_EMAIL,
        to: [params.to],
        subject: params.subject,
        react: getTemplate(params.emailType)(params.templateParams as any),
      })
    );
    return { error: result.error ? new Error(result.error.message) : null };
  }

  async addToBroadcastAudience(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<{ success: boolean; error?: unknown }> {
    // The SDK's audience-based overload requires a definite id; without one
    // the call could only fail server-side anyway, so fail it locally.
    if (!RESEND_BROADCAST_AUDIENCE_ID) {
      return {
        success: false,
        error: new Error("RESEND_BROADCAST_AUDIENCE_ID is not configured"),
      };
    }
    try {
      const resend = await this.getResend();
      await resend.contacts.create({
        email,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        unsubscribed: false,
        audienceId: RESEND_BROADCAST_AUDIENCE_ID,
      });
      return { success: true };
    } catch (error) {
      console.error("Failed to add contact to Resend broadcast audience:", error);
      return { success: false, error };
    }
  }
}

export class LoggingEmailService implements EmailService {
  async sendEmail(params: EmailParams): Promise<{ error: Error | null }> {
    console.info(
      `[EMAIL_INTERCEPTED] to=${params.to} subject="${params.subject}" type=${params.emailType} templateKeys=[${Object.keys(params.templateParams).join(',')}] timestamp=${new Date().toISOString()}`
    );
    return { error: null };
  }

  async addToBroadcastAudience(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<{ success: boolean; error?: unknown }> {
    console.info(
      `[BROADCAST_INTERCEPTED] email=${email} firstName=${firstName || ''} lastName=${lastName || ''} timestamp=${new Date().toISOString()}`
    );
    return { success: true };
  }
}

/**
 * SMTP/Nodemailer implementation for self-hosted deployments. Renders the same
 * React Email templates to HTML and sends them over a plain SMTP connection, so
 * an OSS self-hoster can use their own mail server (Google Workspace, SES,
 * Postfix, …) instead of a Resend account.
 *
 * Audience enrollment is Resend-only — SMTP has no audience concept — so
 * addToBroadcastAudience is a logged no-op here. In the hosted product,
 * confirmed signups still enroll in the Resend audience, and broadcasts to it
 * are composed and sent from Resend directly.
 */
export class SmtpEmailService implements EmailService {
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      // Coerce here rather than relying on the zod `z.coerce.number` in env.ts:
      // Vercel deploys force-skip validation, so SMTP_PORT can arrive as a raw
      // string. nodemailer wants a number.
      port: SMTP_PORT === undefined ? undefined : Number(SMTP_PORT),
      // TLS-on-connect for port 465; STARTTLS (587) is negotiated automatically.
      // Accept the common truthy spellings so port 465 + e.g. SMTP_SECURE=1
      // doesn't silently fall back to plaintext.
      secure: isTruthyEnv(SMTP_SECURE),
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }

  async sendEmail(params: EmailParams): Promise<{ error: Error | null }> {
    try {
      // Render the same element to HTML and plaintext. nodemailer (unlike
      // Resend) does not auto-derive a text/plain part, and HTML-only mail
      // scores worse on spam filters / renders blank in text-only clients.
      const element = getTemplate(params.emailType)(params.templateParams as any);
      const [html, text] = await Promise.all([
        render(element),
        render(element, { plainText: true }),
      ]);
      await withSendTimeout(
        this.transporter.sendMail({
          from: `AgentMark <${FROM_EMAIL}>`,
          replyTo: REPLY_TO_EMAIL,
          to: params.to,
          subject: params.subject,
          html,
          text,
        })
      );
      return { error: null };
    } catch (err) {
      // Unlike Resend (which returns { error }), Nodemailer throws on failure;
      // normalize to the EmailService contract.
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async addToBroadcastAudience(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<{ success: boolean; error?: unknown }> {
    console.info(
      `[BROADCAST_SKIPPED_SMTP] email=${email} firstName=${firstName || ''} lastName=${lastName || ''} timestamp=${new Date().toISOString()}`
    );
    return { success: true };
  }
}

/**
 * Recipient guard: delegates to a real provider only for addresses on the
 * allowlist, and drops everything else with a log line.
 *
 * A dropped send returns `{ error: null }` — the same shape a delivered one
 * returns — because callers treat a send error as a user-visible failure
 * (MembershipService rolls the invite back to "resend it"). A recipient off
 * the allowlist is a deliberate policy drop, not a delivery fault, so the
 * caller's happy path is the correct one.
 *
 * This wraps the provider rather than living inside it so the rule holds for
 * every backend, present and future — a new adapter cannot forget it.
 */
export class AllowlistEmailService implements EmailService {
  constructor(
    private readonly delegate: EmailService,
    private readonly allowlist: string[]
  ) {}

  async sendEmail(params: EmailParams): Promise<{ error: Error | null }> {
    if (!isEmailAllowed(params.to, this.allowlist)) {
      console.info(
        `[EMAIL_SUPPRESSED_NOT_ALLOWLISTED] to=${params.to} subject="${params.subject}" type=${params.emailType} timestamp=${new Date().toISOString()}`
      );
      return { error: null };
    }
    return this.delegate.sendEmail(params);
  }

  async addToBroadcastAudience(
    email: string,
    firstName?: string,
    lastName?: string
  ): Promise<{ success: boolean; error?: unknown }> {
    if (!isEmailAllowed(email, this.allowlist)) {
      console.info(
        `[BROADCAST_SUPPRESSED_NOT_ALLOWLISTED] email=${email} timestamp=${new Date().toISOString()}`
      );
      return { success: true };
    }
    return this.delegate.addToBroadcastAudience(email, firstName, lastName);
  }
}

/**
 * Factory: resolves the email toggle (shared `resolveToggle` seam) and returns
 * the matching adapter — `smtp` → Nodemailer, `resend` → Resend. When email is
 * disabled it returns LoggingEmailService (fail-closed). The enabled/backend
 * decision lives in {@link resolveEmailConfig} so it is unit-testable without
 * reloading the env module.
 *
 * With EMAIL_RECIPIENT_ALLOWLIST set, the chosen provider is wrapped in
 * {@link AllowlistEmailService}. Unset (the hosted-production case) the
 * provider is returned bare — see {@link resolveRecipientAllowlist} for why an
 * absent allowlist must not mean "send to nobody".
 */
export function createEmailService(): EmailService {
  const { enabled, backend } = resolveEmailConfig({
    EMAIL_ENABLED,
    EMAIL_PROVIDER,
  });
  if (!enabled) {
    return new LoggingEmailService();
  }
  const provider = backend === 'smtp' ? new SmtpEmailService() : new DefaultEmailService();
  const allowlist = resolveRecipientAllowlist({ EMAIL_RECIPIENT_ALLOWLIST });
  return allowlist.length > 0 ? new AllowlistEmailService(provider, allowlist) : provider;
}

// ============================================================================
// Rate Limit Service
// ============================================================================

interface RateLimitResult {
  success: boolean;
}

export interface RateLimitService {
  limit(identifier: string): Promise<RateLimitResult>;
}

class DefaultRateLimitService implements RateLimitService {
  private ratelimit: Ratelimit;

  constructor(
    namespace: string = "agentmark",
    duration: "1 h" | "1 m" | "1 d" = "1 h",
    limit: number = 2
  ) {
    this.ratelimit = new Ratelimit({
      rootKey: UNKEY_API_KEY,
      namespace,
      duration,
      limit,
    });
  }

  async limit(identifier: string): Promise<RateLimitResult> {
    return this.ratelimit.limit(identifier);
  }
}

/**
 * Creates a rate limiter for invite emails (2 per hour per tenant+email)
 */
export function createInviteRateLimiter(): RateLimitService {
  return new DefaultRateLimitService("agentmark", "1 h", 2);
}
