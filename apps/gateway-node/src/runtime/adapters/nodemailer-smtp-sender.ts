/**
 * `SmtpEmailSender` for the Node self-host entrypoint — the one runtime that
 * can actually open a raw SMTP socket. `nodemailer` is imported ONLY here,
 * never from `@repo/gateway-core` (its `net`/`tls` Node built-ins can't
 * bundle for the Cloudflare Worker; the gateway-core import guard rejects
 * exactly this class of import from core).
 *
 * Stateless by design: `send()` receives the full connection config +
 * message, so a transporter is built fresh per call rather than threading
 * SMTP_* env through the composition root. Management-API invite/role/remove
 * mail is low-volume enough that per-call transporter construction is a
 * non-issue — mirrors the dashboard's own `SmtpEmailService`, which likewise
 * builds one transporter per service instance (itself constructed per
 * request).
 */
import nodemailer from "nodemailer";
import type { SmtpEmailSender, SmtpSendParams } from "@repo/gateway-core/runtime/gateway-context";

export class NodemailerSmtpEmailSender implements SmtpEmailSender {
  readonly supported = true;

  async send(params: SmtpSendParams): Promise<{ error: Error | null }> {
    try {
      const transporter = nodemailer.createTransport({
        host: params.host,
        port: params.port,
        secure: params.secure,
        auth: params.user ? { user: params.user, pass: params.pass } : undefined,
      });
      await transporter.sendMail({
        from: params.from,
        replyTo: params.replyTo,
        to: params.to,
        subject: params.subject,
        html: params.html,
      });
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}
