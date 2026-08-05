// @vitest-environment node
/**
 * Integration test for the SMTP/Nodemailer email adapter.
 *
 * Unlike index.test.ts (which mocks nodemailer + @react-email/render to assert
 * wiring), this stands up a REAL in-process SMTP server and drives the REAL
 * SmtpEmailService through it — so it proves the things mocks can't:
 *   - the actual React Email template renders to HTML without throwing,
 *   - Nodemailer connects/authenticates/sends against a speaking SMTP peer,
 *   - the SMTP envelope and message headers/body arrive intact.
 *
 * No Docker: smtp-server binds an ephemeral localhost port inside the test.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';
import { EmailType } from '../../utils/email';

// The global setup stubs every @repo/transactional export as () => null (to dodge
// ESM import issues). For a real-render test we need the genuine InviteEmail —
// import the actual component source (others stay null; we only send Invite).
vi.mock('@repo/transactional', async () => {
  const invite = await vi.importActual<
    typeof import('../../../../../packages/transactional/emails/invite-user')
  >('../../../../../packages/transactional/emails/invite-user');
  return {
    InviteEmail: invite.InviteEmail,
    BuildFailureEmail: () => null,
    RoleChangedEmail: () => null,
    RemovedFromOrgEmail: () => null,
    TempAccessNotificationEmail: () => null,
  };
});

const FROM_EMAIL = 'int-from@example.com';
const REPLY_TO_EMAIL = 'int-reply@example.com';

type Received = { parsed: ParsedMail; mailFrom: string | false; rcptTo: string[] };

let server: SMTPServer;
let port: number;
const received: Received[] = [];

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'], // accept plaintext; no TLS/auth dance
    onData(stream, session, callback) {
      simpleParser(stream)
        .then((parsed) => {
          received.push({
            parsed,
            mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : false,
            rcptTo: session.envelope.rcptTo.map((r) => r.address),
          });
          callback();
        })
        .catch((err) => callback(err as Error));
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SmtpEmailService (integration: real SMTP + real template render)', () => {
  it('renders the invite template and delivers it over SMTP with intact headers/body', async () => {
    received.length = 0;

    // Point the adapter at the in-process server. Replacing config-global.server
    // wholesale keeps real nodemailer/@react-email/render/@repo/transactional.
    vi.resetModules();
    vi.doMock('../../config-global.server', () => ({
      STRIPE_SECRET_KEY: 's',
      UNKEY_API_KEY: 'u',
      RESEND_API_KEY: 'r',
      RESEND_BROADCAST_AUDIENCE_ID: 'a',
      FROM_EMAIL,
      REPLY_TO_EMAIL,
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      SMTP_USER: undefined,
      SMTP_PASS: undefined,
      SMTP_SECURE: undefined,
    }));

    const { SmtpEmailService } = await import('.');
    const service = new SmtpEmailService();

    const recipient = 'invitee@example.com';
    const subject = 'You have been invited to AcmeIntegrationCo';
    const result = await service.sendEmail({
      to: recipient,
      subject,
      emailType: EmailType.Invite,
      templateParams: {
        inviteLink: 'https://app.example.com/invite/abc123',
        appUrl: 'https://app.example.com',
        companyName: 'AcmeIntegrationCo',
      },
    });

    expect(result).toEqual({ error: null });
    expect(received).toHaveLength(1);

    const first = received[0];
    if (!first) throw new Error('expected the SMTP server to receive one message');
    const { parsed, mailFrom, rcptTo } = first;

    // SMTP envelope reached the server correctly.
    expect(mailFrom).toBe(FROM_EMAIL);
    expect(rcptTo).toEqual([recipient]);

    // Message headers.
    expect(parsed.subject).toBe(subject);
    expect(parsed.from?.value[0]).toMatchObject({ address: FROM_EMAIL, name: 'AgentMark' });
    const toAddr = parsed.to && !Array.isArray(parsed.to) ? parsed.to.value[0]?.address : undefined;
    expect(toAddr).toBe(recipient);
    expect(parsed.replyTo?.value[0]?.address).toBe(REPLY_TO_EMAIL);

    // Real rendered HTML body — content from the InviteEmail template survived
    // render + SMTP transfer (proves the template actually rendered).
    expect(typeof parsed.html).toBe('string');
    expect(parsed.html as string).toContain('AcmeIntegrationCo');
    expect(parsed.html as string).toContain('Join the team');
    expect(parsed.html as string).toContain('https://app.example.com/invite/abc123');

    // Plaintext alternative part is present (better deliverability than HTML-only).
    expect(typeof parsed.text).toBe('string');
    expect(parsed.text as string).toContain('AcmeIntegrationCo');

    vi.doUnmock('../../config-global.server');
    vi.resetModules();
  });
});
