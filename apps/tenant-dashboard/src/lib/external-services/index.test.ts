import type { Mock, MockInstance } from 'vitest';
import { InviteEmail, BuildFailureEmail, RoleChangedEmail, RemovedFromOrgEmail, TempAccessNotificationEmail } from '@repo/transactional';

// Mock Resend SDK — hoisted before external-services imports Resend
const mockSend = vi.fn();
const mockContactCreate = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () {
    return {
      emails: { send: mockSend },
      contacts: { create: mockContactCreate },
    };
  }),
}));

// Mock Nodemailer — vi.hoisted runs before the vi.mock factory, so both the
// transport's sendMail and the createTransport spy are initialized in time
// (avoids the hoisting TDZ that bites plain top-level consts).
const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { mockSendMail: sendMail, mockCreateTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

// Mock @react-email/render — distinct HTML vs plaintext output so we can assert
// both parts of the SMTP message.
vi.mock('@react-email/render', () => ({
  render: vi.fn(async (_element: unknown, opts?: { plainText?: boolean }) =>
    opts?.plainText ? 'plain-text-body' : '<html>rendered</html>'
  ),
}));

// Override @repo/transactional with correct export names matching external-services.ts imports
vi.mock('@repo/transactional', () => ({
  InviteEmail: vi.fn(() => 'invite-rendered'),
  BuildFailureEmail: vi.fn(() => 'build-failure-rendered'),
  RoleChangedEmail: vi.fn(() => 'role-changed-rendered'),
  RemovedFromOrgEmail: vi.fn(() => 'removed-from-org-rendered'),
  TempAccessNotificationEmail: vi.fn(() => 'temp-access-rendered'),
}));

import { createEmailService, LoggingEmailService, DefaultEmailService, SmtpEmailService } from '.';
import { render } from '@react-email/render';
import { Resend } from 'resend';
import { EmailType } from '../../utils/email';

// ============================================================================
// LoggingEmailService
// ============================================================================

describe('LoggingEmailService', () => {
  let consoleInfoSpy: MockInstance;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  describe('sendEmail', () => {
    it('logs the intercepted email and returns no error', async () => {
      const service = new LoggingEmailService();
      const result = await service.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        emailType: EmailType.Invite,
        templateParams: { inviteLink: 'https://example.com', appUrl: 'https://app.test', companyName: 'TestCo' },
      });

      expect(result).toEqual({ error: null });
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EMAIL_INTERCEPTED] to=user@example.com')
      );
    });
  });

  describe('addToBroadcastAudience', () => {
    it('logs the intercepted broadcast and returns success', async () => {
      const service = new LoggingEmailService();
      const result = await service.addToBroadcastAudience('user@example.com', 'Jane', 'Doe');

      expect(result).toEqual({ success: true });
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[BROADCAST_INTERCEPTED] email=user@example.com firstName=Jane lastName=Doe')
      );
    });

    it('handles missing name fields', async () => {
      const service = new LoggingEmailService();
      const result = await service.addToBroadcastAudience('user@example.com');

      expect(result).toEqual({ success: true });
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[BROADCAST_INTERCEPTED] email=user@example.com firstName= lastName=')
      );
    });
  });
});

// ============================================================================
// DefaultEmailService — template routing
// ============================================================================

describe('DefaultEmailService', () => {
  beforeEach(() => {
    mockSend.mockReset();
    (InviteEmail as Mock).mockClear();
    (BuildFailureEmail as Mock).mockClear();
    (RoleChangedEmail as Mock).mockClear();
    (RemovedFromOrgEmail as Mock).mockClear();
    (TempAccessNotificationEmail as Mock).mockClear();
  });

  describe('sendEmail', () => {
    it.each([
      [EmailType.Invite, InviteEmail],
      [EmailType.BuildFailure, BuildFailureEmail],
      [EmailType.RoleChanged, RoleChangedEmail],
      [EmailType.RemovedFromOrg, RemovedFromOrgEmail],
      [EmailType.TempAccessNotification, TempAccessNotificationEmail],
    ])('routes %s to the correct template and calls Resend', async (emailType, expectedTemplate) => {
      mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

      const service = new DefaultEmailService();
      const result = await service.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        emailType,
        templateParams: { key: 'value' },
      });

      expect(result).toEqual({ error: null });
      expect(expectedTemplate).toHaveBeenCalledWith({ key: 'value' });
      expect(mockSend).toHaveBeenCalledWith({
        from: expect.stringContaining('AgentMark'),
        replyTo: 'reply@example.com',
        to: ['user@example.com'],
        subject: 'Test Subject',
        react: expect.anything(),
      });
    });

    it('lazily constructs the Resend client once and reuses it across sends', async () => {
      // Guards the lazy-load cache: the SDK is imported/instantiated on first
      // use, not eagerly, and not re-created on every send.
      mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
      (Resend as unknown as Mock).mockClear();

      const service = new DefaultEmailService();
      const params = { subject: 'S', emailType: EmailType.Invite, templateParams: {} };
      await service.sendEmail({ to: 'a@example.com', ...params });
      await service.sendEmail({ to: 'b@example.com', ...params });

      expect(Resend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });
});

// ============================================================================
// SmtpEmailService — Nodemailer adapter for self-hosted deployments
// ============================================================================

describe('SmtpEmailService', () => {
  beforeEach(() => {
    mockSendMail.mockReset();
    mockCreateTransport.mockClear();
    (render as Mock).mockClear();
    (InviteEmail as Mock).mockClear();
  });

  describe('sendEmail', () => {
    it('renders the routed template to HTML and sends it over SMTP', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-1' });

      const service = new SmtpEmailService();
      const result = await service.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        emailType: EmailType.Invite,
        templateParams: { key: 'value' },
      });

      expect(result).toEqual({ error: null });
      // Template is selected by emailType, invoked with the params, then rendered
      // to both HTML and a plaintext alternative.
      expect(InviteEmail).toHaveBeenCalledWith({ key: 'value' });
      expect(render).toHaveBeenCalledWith('invite-rendered');
      expect(render).toHaveBeenCalledWith('invite-rendered', { plainText: true });
      expect(mockSendMail).toHaveBeenCalledWith({
        from: expect.stringContaining('AgentMark'),
        replyTo: 'reply@example.com',
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<html>rendered</html>',
        text: 'plain-text-body',
      });
    });

    it('builds the transport with secure off and no auth when SMTP creds are unset', async () => {
      // unit-test-setup leaves SMTP_* undefined → secure must default false and
      // auth must be omitted (sending auth:{user:undefined} breaks real relays).
      mockSendMail.mockResolvedValue({ messageId: 'msg-1' });

      new SmtpEmailService();

      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: undefined,
        port: undefined,
        secure: false,
        auth: undefined,
      });
    });

    it('returns a timeout error when the transport hangs past 10s', async () => {
      vi.useFakeTimers();
      try {
        // Never resolves — only the 10s timeout can settle the race.
        mockSendMail.mockReturnValue(new Promise(() => {}));

        const service = new SmtpEmailService();
        const pending = service.sendEmail({
          to: 'user@example.com',
          subject: 'Test Subject',
          emailType: EmailType.Invite,
          templateParams: {},
        });

        await vi.advanceTimersByTimeAsync(10_000);
        const result = await pending;

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error?.message).toBe('Email send timed out after 10s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('normalizes a thrown transport failure to { error } (does not throw)', async () => {
      mockSendMail.mockRejectedValue(new Error('connection refused'));

      const service = new SmtpEmailService();
      const result = await service.sendEmail({
        to: 'user@example.com',
        subject: 'Subj',
        emailType: EmailType.Invite,
        templateParams: {},
      });

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('connection refused');
    });
  });

  describe('addToBroadcastAudience', () => {
    it('is a logged no-op that reports success (SMTP has no audience concept)', async () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const service = new SmtpEmailService();
      const result = await service.addToBroadcastAudience('user@example.com', 'Jane', 'Doe');

      expect(result).toEqual({ success: true });
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[BROADCAST_SKIPPED_SMTP] email=user@example.com firstName=Jane lastName=Doe')
      );

      consoleInfoSpy.mockRestore();
    });
  });
});

// ============================================================================
// createEmailService factory
// ============================================================================

describe('createEmailService', () => {
  afterEach(() => {
    vi.doUnmock('../../config-global.server');
    vi.resetModules();
  });

  it('returns LoggingEmailService when EMAIL_ENABLED is not true', () => {
    // unit-test-setup sets EMAIL_ENABLED to 'false'
    const service = createEmailService();
    expect(service).toBeInstanceOf(LoggingEmailService);
  });

  // Re-import external-services against a config-global.server mock so the
  // module-level provider/enabled flags resolve to the values under test.
  async function importFactoryWith(overrides: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock('../../config-global.server', () => ({
      STRIPE_SECRET_KEY: 's',
      UNKEY_API_KEY: 'u',
      RESEND_API_KEY: 'r',
      RESEND_BROADCAST_AUDIENCE_ID: 'a',
      FROM_EMAIL: 'from@example.com',
      REPLY_TO_EMAIL: 'reply@example.com',
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASS: undefined,
      SMTP_SECURE: undefined,
      ...overrides,
    }));
    return import('.');
  }

  it('returns SmtpEmailService when enabled with the smtp provider', async () => {
    const mod = await importFactoryWith({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.test',
      SMTP_PORT: 587,
    });
    expect(mod.createEmailService()).toBeInstanceOf(mod.SmtpEmailService);
  });

  it('returns DefaultEmailService when enabled with the resend provider', async () => {
    const mod = await importFactoryWith({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'resend',
    });
    expect(mod.createEmailService()).toBeInstanceOf(mod.DefaultEmailService);
  });

  it('creates the Resend contact in the configured broadcast audience', async () => {
    mockContactCreate.mockClear();
    mockContactCreate.mockResolvedValue({ data: { id: 'contact-1' }, error: null });
    const mod = await importFactoryWith({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'resend',
    });
    const service = new mod.DefaultEmailService();

    const result = await service.addToBroadcastAudience('user@example.com', 'Jane', 'Doe');

    expect(result).toEqual({ success: true });
    expect(mockContactCreate).toHaveBeenCalledWith({
      email: 'user@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      unsubscribed: false,
      audienceId: 'a',
    });
  });

  it('fails locally without calling Resend when no broadcast audience id is configured', async () => {
    mockContactCreate.mockClear();
    const mod = await importFactoryWith({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'resend',
      RESEND_BROADCAST_AUDIENCE_ID: undefined,
    });
    const service = new mod.DefaultEmailService();

    const result = await service.addToBroadcastAudience('user@example.com');

    expect(result.success).toBe(false);
    expect(String((result.error as Error).message)).toContain('RESEND_BROADCAST_AUDIENCE_ID');
    expect(mockContactCreate).not.toHaveBeenCalled();
  });

  it('builds the SMTP transport with TLS on and auth when creds are set', async () => {
    mockCreateTransport.mockClear();
    const mod = await importFactoryWith({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 465,
      SMTP_SECURE: 'true',
      SMTP_USER: 'apikey',
      SMTP_PASS: 's3cret',
    });

    new mod.SmtpEmailService();

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'apikey', pass: 's3cret' },
    });
  });

  it('coerces a string SMTP_PORT and accepts non-"true" truthy SMTP_SECURE', async () => {
    // On Vercel, env.ts force-skips zod validation, so SMTP_PORT arrives as the
    // raw string and SMTP_SECURE may be '1'/'yes'. The adapter must still pass a
    // numeric port and secure:true to nodemailer.
    mockCreateTransport.mockClear();
    const mod = await importFactoryWith({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'yes',
    });

    new mod.SmtpEmailService();

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 2525,
      secure: true,
      auth: undefined,
    });
  });
});
