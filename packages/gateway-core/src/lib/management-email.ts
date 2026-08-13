/**
 * The three `EmailService` providers for management-API-key invite /
 * role-changed / removed-from-org sends, each rendering the same
 * `@repo/transactional` React Email templates the dashboard uses:
 *
 *   - `buildResendManagementEmailService` — posts directly to Resend's REST
 *     API (`POST /emails`) rather than pulling in the `resend` npm SDK —
 *     Resend's send endpoint is a plain JSON-over-fetch call, so a raw
 *     `fetch` keeps this adapter's Workers-bundle footprint to just the
 *     templates + the renderer.
 *   - `buildSmtpManagementEmailService` — delegates the socket work to an
 *     injected `SmtpEmailSender` (see `runtime/gateway-context.ts`); never
 *     imports `nodemailer` directly (can't bundle for Workers).
 *   - `buildLogManagementEmailService` — the dev fallback: renders the
 *     template, logs the recipient/subject/action-links, sends nothing.
 *
 * Provider SELECTION (which of these three gets built, from what env) lives
 * in `management-adapters.ts`'s `buildManagementEmailService` — this module
 * only knows how to render + deliver once a provider has been chosen.
 *
 * `@react-email/render` and `@react-email/components` both resolve their
 * `workerd`/`edge-light` export condition when bundled for the Cloudflare
 * Worker (wrangler's esbuild honors those conditions), so `render()` never
 * pulls in `node:stream` here — only under Node test runners, which resolve
 * the `node` condition instead. Either way the output is the same HTML
 * string.
 */

import { render } from '@react-email/render';
import { InviteEmail, RoleChangedEmail, RemovedFromOrgEmail } from '@repo/transactional';
import type { EmailSendResult, EmailService } from '@repo/org-management-service';
import type { SmtpEmailSender } from '../runtime/gateway-context';

const RESEND_SEND_URL = 'https://api.resend.com/emails';
const EMAIL_SEND_TIMEOUT_MS = 10_000;

/** Race a send against a fixed timeout, matching the dashboard's own `EMAIL_SEND_TIMEOUT_MS` contract. */
async function withSendTimeout<T>(send: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Email send timed out after 10s')), EMAIL_SEND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([send, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/** The three membership-lifecycle email kinds `MembershipService` ever sends (see `@repo/org-management-service`'s `EmailService` doc comment). */
type ManagementEmailType = 'invite' | 'role_changed' | 'removed_from_org';

/** Shared by every provider adapter below (Resend, SMTP, log) so template selection lives in exactly one place. */
export async function renderManagementEmailTemplate(
  emailType: string,
  templateParams: Record<string, unknown>,
): Promise<string> {
  switch (emailType as ManagementEmailType) {
    case 'invite':
      return render(
        InviteEmail(templateParams as { inviteLink?: string; appUrl: string; companyName?: string }),
      );
    case 'role_changed':
      return render(
        RoleChangedEmail(
          templateParams as { appUrl: string; orgName: string; oldRole: string; newRole: string },
        ),
      );
    case 'removed_from_org':
      return render(RemovedFromOrgEmail(templateParams as { appUrl: string; orgName: string }));
    default:
      throw new Error(`Unsupported management email type: ${emailType}`);
  }
}

export interface ResendManagementEmailEnv {
  resendApiKey: string;
  fromEmail: string;
  replyToEmail?: string;
}

/**
 * Real Resend-backed sender, wired only when `RESEND_API_KEY` + `FROM_EMAIL`
 * are both configured on the deployment (see `buildManagementEmailService`
 * in `management-adapters.ts` for the unset-env fail-closed path).
 */
export function buildResendManagementEmailService(env: ResendManagementEmailEnv): EmailService {
  return {
    async sendEmail(params): Promise<EmailSendResult> {
      let html: string;
      try {
        html = await renderManagementEmailTemplate(params.emailType, params.templateParams);
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }

      try {
        const response = await withSendTimeout(
          fetch(RESEND_SEND_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.resendApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: `AgentMark <${env.fromEmail}>`,
              ...(env.replyToEmail ? { reply_to: env.replyToEmail } : {}),
              to: [params.to],
              subject: params.subject,
              html,
            }),
          }),
        );
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            error: new Error(`Resend send failed (${response.status}): ${body || response.statusText}`),
          };
        }
        return { error: null };
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  };
}

export interface SmtpManagementEmailEnv {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  fromEmail: string;
  replyToEmail?: string;
}

/**
 * SMTP-backed sender — delegates the actual socket work to the injected
 * `SmtpEmailSender` (see `runtime/gateway-context.ts`'s doc comment for why
 * that indirection exists: `nodemailer` cannot live in this package). Callers
 * MUST check `sender.supported` before calling this — see
 * `buildManagementEmailService` in `management-adapters.ts`, which is the one
 * place that decision gets made.
 */
export function buildSmtpManagementEmailService(
  env: SmtpManagementEmailEnv,
  sender: SmtpEmailSender,
): EmailService {
  return {
    async sendEmail(params): Promise<EmailSendResult> {
      let html: string;
      try {
        html = await renderManagementEmailTemplate(params.emailType, params.templateParams);
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }
      return sender.send({
        host: env.host,
        port: env.port,
        secure: env.secure,
        user: env.user,
        pass: env.pass,
        to: params.to,
        from: `AgentMark <${env.fromEmail}>`,
        replyTo: env.replyToEmail,
        subject: params.subject,
        html,
      });
    },
  };
}

/**
 * The HTML entities React Email's renderer escapes an attribute value with.
 * `&amp;` MUST decode last — decoding it first would turn a literal `&lt;`
 * back into `<` a second time (`&amp;lt;` → `&lt;` → `<`), corrupting any
 * URL whose query string itself contains an encoded ampersand.
 */
const HTML_ENTITY_DECODE_ORDER: ReadonlyArray<[string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&amp;', '&'],
];

/**
 * Reverses attribute-value HTML-escaping on an extracted `href`. Rendered
 * templates join multi-param query strings with `&amp;` (e.g.
 * `...&amp;type=invite&amp;next=...`) — logged verbatim, that string breaks
 * the moment a developer pastes/curls it, defeating the whole point of log
 * mode (a directly usable link). Handles the four attribute entities React
 * Email's renderer emits plus `&amp;`; not a general HTML-entity decoder
 * (no numeric/named entity table) — email templates carry no other entities
 * in an href.
 */
function decodeHtmlEntities(value: string): string {
  return HTML_ENTITY_DECODE_ORDER.reduce(
    (decoded, [entity, char]) => decoded.split(entity).join(char),
    value,
  );
}

/**
 * `href="..."` extraction from rendered HTML — every management email
 * template's one actionable link (invite-accept URL, or nothing for
 * role-changed/removed-from-org, which link to no action). Deliberately NOT
 * the full HTML blob: log-mode's whole point is a developer scanning
 * terminal output for the link to click, not reconstructing an email client.
 */
function extractLinks(html: string): string[] {
  const links: string[] = [];
  const hrefPattern = /href="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1];
    if (href) links.push(decodeHtmlEntities(href));
  }
  return links;
}

/**
 * Dev-mode fallback — renders the real template (so a broken template still
 * surfaces as a render error, same as every other provider) but never sends
 * anything over the network. Logs one structured line per send: recipient,
 * subject, and the extracted action link(s), which is what a developer
 * running `yarn dev` actually needs to click through an invite. Selected only
 * when `NODE_ENV=development` (see `buildManagementEmailService`) — never
 * reachable in staging/production, so real recipient addresses never end up
 * in production logs.
 */
export function buildLogManagementEmailService(): EmailService {
  return {
    async sendEmail(params): Promise<EmailSendResult> {
      let html: string;
      try {
        html = await renderManagementEmailTemplate(params.emailType, params.templateParams);
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }
      console.info(
        '[management-email:log-mode]',
        JSON.stringify({
          to: params.to,
          subject: params.subject,
          emailType: params.emailType,
          links: extractLinks(html),
        }),
      );
      return { error: null };
    },
  };
}
