/**
 * Tests: EmailRegistrationService — registration outcomes, duplicate-email
 * handling, and auth-user cleanup semantics.
 */

import * as adminClientModule from '../admin-client';
import { EmailRegistrationService } from './email-registration';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockSignUp = vi.fn();
const mockDeleteUser = vi.fn();
const mockInsert = vi.fn();

const mockLogServerInfo = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockLogServerError = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../adapters/server-error-log', () => ({
  logServerInfo: mockLogServerInfo,
  logServerError: mockLogServerError,
}));

vi.mock('../../../utils/scrub-email', () => ({
  scrubEmail: vi.fn((email: string) => email),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validInput = {
  email: 'alice@acme.com',
  password: 'StrongP@ss1',
  firstName: 'Alice',
  lastName: 'Smith',
  redirectUrl: 'https://app.test/callback',
};

function setupSuccessMocks() {
  mockSignUp.mockResolvedValue({
    data: { user: { id: 'user-123', identities: [{ provider: 'email' }] } },
    error: null,
  });
  mockInsert.mockResolvedValue({ error: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailRegistrationService', () => {
  let service: EmailRegistrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
    vi.spyOn(adminClientModule, 'getAdminDataClient').mockReturnValue({
      auth: {
        admin: {
          deleteUser: mockDeleteUser,
        },
      },
      from: vi.fn(() => ({
        insert: mockInsert,
      })),
    } as any);

    service = new EmailRegistrationService({
      supabaseClient: {
        auth: { signUp: mockSignUp },
      } as any,
    });
  });

  it('returns the created userId on successful registration', async () => {
    const result = await service.registerUser(
      validInput.email,
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl
    );

    expect(result).toEqual({ data: { userId: 'user-123' } });
  });

  it('returns the generic failure message when auth signup fails', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null },
      error: { message: 'Auth error' },
    });

    const result = await service.registerUser(
      validInput.email,
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl
    );

    expect(result).toEqual({
      error: 'Registration failed. Please try again or contact support if the problem persists.',
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('should log at INFO (not ERROR) when signUp returns "User already registered"', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null },
      error: { message: 'User already registered' },
    });

    const result = await service.registerUser(
      validInput.email,
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl
    );

    expect(result).toEqual({
      error: 'Registration failed. Please try again or contact support if the problem persists.',
    });
    expect(mockLogServerInfo).toHaveBeenCalledWith(
      'Registration rejected - email exists (unconfirmed)',
      expect.objectContaining({ email: validInput.email }),
    );
    expect(mockLogServerError).not.toHaveBeenCalled();
  });

  it('should reject and not delete user when signUp returns empty identities (existing confirmed email)', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'existing-id', identities: [] } },
      error: null,
    });

    const result = await service.registerUser(
      validInput.email,
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl
    );

    expect(result).toEqual({
      error: 'Registration failed. Please try again or contact support if the problem persists.',
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('should not call deleteUser when profile insert fails with 23505 duplicate', async () => {
    mockInsert.mockResolvedValue({
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "profile_pkey"',
      },
    });

    const result = await service.registerUser(
      validInput.email,
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl
    );

    expect(result).toHaveProperty('error');
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('should call deleteUser when profile insert fails with a non-duplicate error', async () => {
    mockInsert.mockResolvedValue({
      error: { code: '23503', message: 'foreign key violation' },
    });

    const result = await service.registerUser(
      validInput.email,
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl
    );

    expect(result).toHaveProperty('error');
    expect(mockDeleteUser).toHaveBeenCalledWith('user-123');
  });

  it('normalizes email (trim + lowercase) and trims first/last name before persisting', async () => {
    const result = await service.registerUser(
      '  Alice@ACME.com  ',
      validInput.password,
      '  Alice  ',
      '  Smith  ',
      validInput.redirectUrl,
    );

    // Success returns the created user id.
    expect(result).toEqual({ data: { userId: 'user-123' } });

    // signUp receives the trimmed + lowercased email (kills the email
    // `.trim()` / `.toLowerCase()` MethodExpression survivors — dropping either
    // leaves spaces or uppercase, or makes `.email()` reject the padded value).
    expect(mockSignUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@acme.com' }),
    );

    // Profile insert uses the normalized email and the trimmed full name
    // (kills the firstName/lastName `.trim()` MethodExpression survivors —
    // without trim the name would be '  Alice     Smith  ').
    expect(mockInsert).toHaveBeenCalledWith({
      id: 'user-123',
      email: 'alice@acme.com',
      name: 'Alice Smith',
    });
  });

  it('returns the exact first validation message (not the ZodError JSON blob or the fallback) on invalid email', async () => {
    const result = await service.registerUser(
      'bad-email',
      validInput.password,
      validInput.firstName,
      validInput.lastName,
      validInput.redirectUrl,
    );

    // Exact match pins the specific issue message. A JSON-blob mutant (the
    // `err instanceof z.ZodError` ternary flipped to its else-branch, returning
    // `err?.message`) or the `?? fallback` LogicalOperator mutant would produce
    // a different string, so this kills both the L79 `??` and L80 ternary survivors.
    expect(result).toEqual({ error: 'Invalid email address' });
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
