/**
 * `SmtpEmailSender` for runtimes that cannot open a raw SMTP socket — the
 * Cloudflare Worker's injection (`apps/gateway`'s composition root). Every
 * send fails with a clear, actionable message instead of attempting a
 * connection that can only fail; `supported: false` lets
 * `management-adapters.ts` reject `EMAIL_PROVIDER=smtp` before ever calling
 * `send()`.
 *
 * Vendor-free (no `nodemailer`), so it's safe for both the CF composition
 * root and the shared test-helper default (`fake-gateway-context.ts`) — the
 * gateway-core import guard would reject a runtime SMTP client here.
 */
import type { SmtpEmailSender, SmtpSendParams } from '../gateway-context';

export class NotSupportedSmtpEmailSender implements SmtpEmailSender {
  readonly supported = false;

  async send(_params: SmtpSendParams): Promise<{ error: Error | null }> {
    return {
      error: new Error(
        'SMTP email delivery is not available on this gateway runtime — Cloudflare Workers cannot open raw SMTP sockets. Set EMAIL_PROVIDER=resend, or run the Node self-host entrypoint for SMTP.',
      ),
    };
  }
}
