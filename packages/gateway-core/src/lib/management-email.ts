/**
 * Resend-backed `EmailService` for management-API-key invite / role-changed /
 * removed-from-org sends. Renders the same `@repo/transactional` React Email
 * templates the dashboard uses, then posts directly to Resend's REST API
 * (`POST /emails`) rather than pulling in the `resend` npm SDK — Resend's
 * send endpoint is a plain JSON-over-fetch call, so a raw `fetch` keeps this
 * adapter's Workers-bundle footprint to just the templates + the renderer.
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

async function renderTemplate(emailType: string, templateParams: Record<string, unknown>): Promise<string> {
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
        html = await renderTemplate(params.emailType, params.templateParams);
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
