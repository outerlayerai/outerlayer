// @vitest-environment node
/**
 * Register page — `return_to` sanitization tests.
 *
 * Regression: the page must read the `return_to` search param and hand the
 * SANITIZED value to the view (which threads it through OAuth and the
 * confirmation email). Off-site values must be dropped, never forwarded.
 */
import RegisterPage from './page';

vi.mock('@/features/auth', () => ({
  RegisterView: () => null,
}));

vi.mock('@/lib/system', () => ({
  createEmailRegistrationService: vi.fn(),
  recordTermsAgreementForUser: vi.fn(),
}));

describe('RegisterPage — return_to param', () => {
  it('passes a safe return_to through to the view', async () => {
    const element = await RegisterPage({
      searchParams: Promise.resolve({ return_to: '/auth/accept-invite?id=abc-123' }),
    });

    expect(element.props.returnTo).toBe('/auth/accept-invite?id=abc-123');
  });

  it('drops an off-site return_to', async () => {
    const element = await RegisterPage({
      searchParams: Promise.resolve({ return_to: 'https://evil.example.com/' }),
    });

    expect(element.props.returnTo).toBeNull();
  });

  it('passes null when no return_to is present', async () => {
    const element = await RegisterPage({ searchParams: Promise.resolve({}) });

    expect(element.props.returnTo).toBeNull();
  });
});
