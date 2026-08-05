// @vitest-environment jsdom
/**
 * LoginView submit-failure tests.
 *
 * Regression: the onSubmit catch block called react-hook-form's `reset()`
 * unconditionally before showing the error, wiping email + password on every
 * failed login attempt (the hottest auth error path — wrong password).
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react';

import { useAuthContext } from '@/lib/adapters/use-auth-context';
import { checkDomainSSO, validatePasswordLoginAllowed } from '@/utils/sso-actions';
import LoginView from './login-view';

// Server actions — true seams (owned modules, stable signatures, no HTTP
// crossed by the test). The real module is "use server" and pulls in
// Supabase admin/server clients that must not load under jsdom.
vi.mock('@/utils/sso-actions', () => ({
  checkDomainSSO: vi.fn(),
  validatePasswordLoginAllowed: vi.fn(),
}));

// The global setup's `@/components/hook-form` mock renders plain inputs
// detached from react-hook-form state, so it can never observe a `reset()`
// call. Override locally with a Controller-connected version (same pattern
// as register-view.test.tsx / webhook-form.test.tsx) so the fields
// genuinely round-trip through RHF state.
vi.mock('@/components/hook-form', () => {
  const React = require('react');
  const { Controller, useFormContext, FormProvider: RHFFormProvider } = require('react-hook-form');
  return {
    __esModule: true,
    default: ({ children, methods, onSubmit }: any) => (
      <RHFFormProvider {...methods}>
        <form onSubmit={onSubmit}>{children}</form>
      </RHFFormProvider>
    ),
    RHFTextField: ({ name, label, type }: any) => {
      const { control } = useFormContext();
      return (
        <Controller
          name={name}
          control={control}
          render={({ field }: any) => (
            <label>
              {label}
              <input aria-label={label} type={type || 'text'} {...field} value={field.value ?? ''} />
            </label>
          )}
        />
      );
    },
  };
});

function renderView(overrides: Partial<React.ComponentProps<typeof LoginView>> = {}) {
  const props = {
    loginWithGithub: vi.fn().mockResolvedValue(undefined),
    loginWithGoogle: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return render(<LoginView {...props} />);
}

describe('LoginView — server-side submit errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validatePasswordLoginAllowed).mockResolvedValue({ allowed: true });
    vi.mocked(checkDomainSSO).mockResolvedValue({ hasSso: false, enforced: false });
  });

  it('keeps email and password and shows the alert when login fails', async () => {
    const login = vi.fn().mockRejectedValue(new Error('Invalid login credentials'));
    vi.mocked(useAuthContext).mockReturnValue({
      login,
      logout: vi.fn(),
    } as any);

    const { getByLabelText, findByText, getByText } = renderView();

    fireEvent.change(getByLabelText('auth.login.emailPlaceholder'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(getByLabelText('auth.login.passwordPlaceholder'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(getByText('auth.login.loginButton'));

    await findByText('Invalid login credentials');

    // The bug: reset() wiped both of these on every failed login.
    expect(getByLabelText('auth.login.emailPlaceholder')).toHaveValue('ada@example.com');
    expect(getByLabelText('auth.login.passwordPlaceholder')).toHaveValue('wrong-password');
    expect(login).toHaveBeenCalledWith('ada@example.com', 'wrong-password');
  });

  // proves AC-20 — a successful login with a `returnTo` must hard-navigate
  // via window.location.assign, not router.push. Only a hard nav survives
  // GuestGuard's auth-state effect not reading URL params.
  it('hard-navigates to returnTo on success instead of routing', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAuthContext).mockReturnValue({
      login,
      logout: vi.fn(),
    } as any);
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: assignSpy },
      writable: true,
    });
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockClear();

    const { getByLabelText, getByText } = renderView({ returnTo: '/apps/git-connect/callback' });

    fireEvent.change(getByLabelText('auth.login.emailPlaceholder'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(getByLabelText('auth.login.passwordPlaceholder'), {
      target: { value: 'correct-password' },
    });
    fireEvent.click(getByText('auth.login.loginButton'));

    await vi.waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith('/apps/git-connect/callback');
    });
    // The view never reaches for next/navigation's router on this path — the
    // hard nav above is the only navigation mechanism it uses.
    expect(useRouter).not.toHaveBeenCalled();
  });

  // proves AC-21 — the server-side SSO enforcement check is the guard against
  // client-side bypass; when it denies, login() must never run.
  it('blocks password login and never calls login() when SSO is server-enforced', async () => {
    const login = vi.fn();
    vi.mocked(useAuthContext).mockReturnValue({
      login,
      logout: vi.fn(),
    } as any);
    vi.mocked(validatePasswordLoginAllowed).mockResolvedValue({
      allowed: false,
      error: 'Your organization requires SSO login.',
    });

    const { getByLabelText, getByText, findByText } = renderView();

    fireEvent.change(getByLabelText('auth.login.emailPlaceholder'), {
      target: { value: 'ada@sso-enforced.com' },
    });
    fireEvent.change(getByLabelText('auth.login.passwordPlaceholder'), {
      target: { value: 'whatever' },
    });
    fireEvent.click(getByText('auth.login.loginButton'));

    await findByText('Your organization requires SSO login.');
    expect(login).not.toHaveBeenCalled();
  });
});
