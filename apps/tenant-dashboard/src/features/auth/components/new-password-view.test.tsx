// @vitest-environment jsdom
/**
 * NewPasswordView flow-aware copy tests.
 *
 * Regression: invited users land here straight from the invite email having
 * never had a password, so the password-reset copy ("Update to use your new
 * password") read like an error. The view must render first-time-setup copy
 * when the URL carries `flow=invite`, including the inviting company's name
 * from user_metadata, and keep the reset copy for everyone else.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuthContext } from '@/lib/adapters/use-auth-context';
import NewPasswordView from './new-password-view';

// The global setup mocks `components/hook-form` with inputs detached from
// react-hook-form state, so submitted values never reach the Zod schema and
// validation would always fail on the empty defaults. Stub the resolver to
// hand the submit callback a fixed valid payload — the submit-failure tests
// exercise the callback's error handling, not the validation layer.
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async () => ({
    values: { password: 'SecurePass99!', confirmPassword: 'SecurePass99!' },
    errors: {},
  }),
}));

// The global `@/components/hook-form` mock above renders plain inputs detached
// from react-hook-form state, so it can never observe a `reset()` call — the
// displayed value only ever reflects what fireEvent.change last set, whether
// or not RHF resets internally. Override it with a Controller-connected
// version (same pattern as register-view.test.tsx / webhook-form.test.tsx)
// so the reset()-on-error regression test below can actually detect the wipe.
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

// The global setup mocks `@/components/iconify` to render nothing; override it
// so the hero glyph is visible.
vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

// Override the global locales mock so interpolation params are observable:
// `t(key, { company })` renders as `key:company`, letting assertions pin
// that the company name is actually threaded into the title.
vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.company ? `${key}:${params.company}` : key,
  }),
  LocalizationProvider: ({ children }: any) => children,
  init: () => {},
  i18n: {
    isInitialized: true,
    getResourceBundle: () => undefined,
    addResourceBundle: () => {},
    setDefaultNamespace: () => {},
  },
}));

function mockAuth(companyName?: string) {
  vi.mocked(useAuthContext).mockReturnValue({
    updatePassword: vi.fn(),
    user: companyName ? { user_metadata: { company_name: companyName } } : null,
  } as any);
}

function mockFlow(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as any);
}

describe('NewPasswordView — invite vs reset copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders welcome copy with the company name when flow=invite', () => {
    mockFlow('flow=invite');
    mockAuth('Acme Corp');

    const { getByText, queryByText } = render(<NewPasswordView />);

    expect(getByText('auth.newPassword.inviteTitleWithCompany:Acme Corp')).toBeInTheDocument();
    expect(getByText('auth.newPassword.inviteDescription')).toBeInTheDocument();
    expect(getByText('auth.newPassword.setPasswordButton')).toBeInTheDocument();
    // The reset copy must be fully absent — it is what confused invited users.
    expect(queryByText('auth.newPassword.title')).not.toBeInTheDocument();
    expect(queryByText('auth.newPassword.description')).not.toBeInTheDocument();
    expect(queryByText('auth.newPassword.updateButton')).not.toBeInTheDocument();
  });

  it('falls back to a generic welcome title when the invite has no company name', () => {
    mockFlow('flow=invite');
    mockAuth();

    const { getByText, queryByText } = render(<NewPasswordView />);

    expect(getByText('auth.newPassword.inviteTitle')).toBeInTheDocument();
    expect(getByText('auth.newPassword.inviteDescription')).toBeInTheDocument();
    expect(queryByText('auth.newPassword.title')).not.toBeInTheDocument();
  });

  it('falls back to the generic title for a user object without user_metadata', () => {
    // OAuth-created or partially-hydrated users can lack user_metadata
    // entirely — the company lookup must not blow up on it.
    mockFlow('flow=invite');
    vi.mocked(useAuthContext).mockReturnValue({
      updatePassword: vi.fn(),
      user: {},
    } as any);

    const { getByText } = render(<NewPasswordView />);

    expect(getByText('auth.newPassword.inviteTitle')).toBeInTheDocument();
  });

  it('keeps the password-reset copy when there is no flow param', () => {
    mockFlow('');
    mockAuth('Acme Corp');

    const { getByText, queryByText, container } = render(<NewPasswordView />);

    expect(getByText('auth.newPassword.title')).toBeInTheDocument();
    expect(getByText('auth.newPassword.description')).toBeInTheDocument();
    expect(getByText('auth.newPassword.updateButton')).toBeInTheDocument();

    // Hero mark is the bordered-flat line glyph, not a raster illustration.
    expect(container.querySelector('[data-icon="mdi:key-outline"]')).not.toBeNull();
    // A stale company_name in user_metadata must not flip a reset into a welcome.
    expect(queryByText('auth.newPassword.inviteTitleWithCompany:Acme Corp')).not.toBeInTheDocument();
    expect(queryByText('auth.newPassword.setPasswordButton')).not.toBeInTheDocument();
  });

  it('treats unrelated flow values as the reset flow', () => {
    mockFlow('flow=recovery');
    mockAuth('Acme Corp');

    const { getByText, queryByText } = render(<NewPasswordView />);

    expect(getByText('auth.newPassword.title')).toBeInTheDocument();
    expect(queryByText('auth.newPassword.inviteDescription')).not.toBeInTheDocument();
  });
});

describe('NewPasswordView — submit failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function submitForm(utils: ReturnType<typeof render>) {
    fireEvent.submit(utils.container.querySelector('form')!);
  }

  it('redirects to the link-expired page when the session is missing on submit', async () => {
    // A page loaded from a stale email link has no session — every submit
    // fails with AuthSessionMissingError regardless of the password, so the
    // user must be routed to the explanation page, not shown a raw error.
    mockFlow('');
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    } as any);
    const sessionError = Object.assign(new Error('Auth session missing!'), {
      name: 'AuthSessionMissingError',
    });
    vi.mocked(useAuthContext).mockReturnValue({
      updatePassword: vi.fn().mockRejectedValue(sessionError),
      user: null,
    } as any);

    const utils = render(<NewPasswordView />);
    submitForm(utils);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/link-expired'));
    expect(utils.queryByText('Auth session missing!')).not.toBeInTheDocument();
  });

  it('surfaces other GoTrue errors inline without redirecting', async () => {
    // Weak-password rejections (server-side policy stricter than the form)
    // must keep showing the real reason on the page.
    mockFlow('');
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    } as any);
    vi.mocked(useAuthContext).mockReturnValue({
      updatePassword: vi
        .fn()
        .mockRejectedValue(new Error('Password should be at least 8 characters.')),
      user: null,
    } as any);

    const utils = render(<NewPasswordView />);
    submitForm(utils);

    await waitFor(() =>
      expect(utils.getByText('Password should be at least 8 characters.')).toBeInTheDocument()
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps the typed password values when a non-session error occurs', async () => {
    // A transient server error (network blip, 5xx) must not discard a
    // valid password pair the user typed twice.
    mockFlow('');
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    } as any);
    vi.mocked(useAuthContext).mockReturnValue({
      updatePassword: vi.fn().mockRejectedValue(new Error('Password update failed')),
      user: null,
    } as any);

    const { getByLabelText, findByText } = render(<NewPasswordView />);

    fireEvent.change(getByLabelText('auth.newPassword.passwordPlaceholder'), {
      target: { value: 'SecurePass99!' },
    });
    fireEvent.change(getByLabelText('auth.newPassword.confirmPlaceholder'), {
      target: { value: 'SecurePass99!' },
    });
    fireEvent.submit(getByLabelText('auth.newPassword.passwordPlaceholder').closest('form')!);

    await findByText('Password update failed');

    // The bug: reset() wiped both of these.
    expect(getByLabelText('auth.newPassword.passwordPlaceholder')).toHaveValue('SecurePass99!');
    expect(getByLabelText('auth.newPassword.confirmPlaceholder')).toHaveValue('SecurePass99!');
  });
});
