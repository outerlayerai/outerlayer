/**
 * `NodemailerSmtpEmailSender` — the one `SmtpEmailSender` that actually opens
 * a socket. `nodemailer` itself is stubbed (no real SMTP server in a unit
 * test); these tests pin the request nodemailer receives and that a
 * transport failure surfaces as `{ error }` rather than throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMail = vi.fn();
const createTransport = vi.fn((_config: unknown) => ({ sendMail }));

vi.mock('nodemailer', () => ({
  default: { createTransport: (config: unknown) => createTransport(config) },
}));

const { NodemailerSmtpEmailSender } = await import('./nodemailer-smtp-sender');

beforeEach(() => {
  createTransport.mockClear();
  sendMail.mockReset();
});

describe('NodemailerSmtpEmailSender', () => {
  it('is supported', () => {
    expect(new NodemailerSmtpEmailSender().supported).toBe(true);
  });

  it('builds the transport from the given connection params and sends the exact message', async () => {
    sendMail.mockResolvedValue({ messageId: 'abc' });
    const sender = new NodemailerSmtpEmailSender();

    const result = await sender.send({
      host: 'localhost',
      port: 1025,
      secure: false,
      user: 'smtp-user',
      pass: 'smtp-pass',
      to: 'invitee@example.com',
      from: 'AgentMark <noreply@example.com>',
      replyTo: 'support@example.com',
      subject: "You've been invited",
      html: '<html><body>hi</body></html>',
    });

    expect(result.error).toBeNull();
    expect(createTransport).toHaveBeenCalledWith({
      host: 'localhost',
      port: 1025,
      secure: false,
      auth: { user: 'smtp-user', pass: 'smtp-pass' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'AgentMark <noreply@example.com>',
      replyTo: 'support@example.com',
      to: 'invitee@example.com',
      subject: "You've been invited",
      html: '<html><body>hi</body></html>',
    });
  });

  it('omits auth when no user is given (open relay / IP-allowlisted sender)', async () => {
    sendMail.mockResolvedValue({ messageId: 'abc' });
    const sender = new NodemailerSmtpEmailSender();

    await sender.send({
      host: 'localhost',
      port: 1025,
      secure: false,
      to: 'invitee@example.com',
      from: 'AgentMark <noreply@example.com>',
      subject: 'hi',
      html: '<html></html>',
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('surfaces a transport failure as { error } rather than throwing', async () => {
    sendMail.mockRejectedValue(new Error('connection refused'));
    const sender = new NodemailerSmtpEmailSender();

    const result = await sender.send({
      host: 'localhost',
      port: 1025,
      secure: false,
      to: 'invitee@example.com',
      from: 'AgentMark <noreply@example.com>',
      subject: 'hi',
      html: '<html></html>',
    });

    expect(result.error?.message).toBe('connection refused');
  });
});
