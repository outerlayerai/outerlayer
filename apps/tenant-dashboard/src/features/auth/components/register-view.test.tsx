// @vitest-environment jsdom
/**
 * RegisterView return_to threading tests.
 *
 * Regression: an invited user without an account bounces
 * invite link → login → register. The view must hand the sanitized
 * `returnTo` to BOTH OAuth server actions and keep it on the sign-in
 * link, or the invite destination dies at the signup hop.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react';

// The global setup's `@/components/hook-form` and `../../components/terms-checkbox`
// mocks render plain inputs detached from react-hook-form state, so they can never
// observe a `reset()` call. Override both locally with Controller-connected versions
// so the fields genuinely round-trip through RHF state (per the pattern in
// webhook-form.test.tsx), letting the submit-error test below actually detect
// whether the form gets wiped.
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

vi.mock('../../../components/terms-checkbox', () => {
  const React = require('react');
  const { Controller, useFormContext } = require('react-hook-form');
  return {
    __esModule: true,
    TermsCheckbox: ({ name = 'agreedToTerms' }: any) => {
      const { control } = useFormContext();
      return (
        <Controller
          name={name}
          control={control}
          render={({ field }: any) => (
            <label>
              agree to terms
              <input
                type="checkbox"
                aria-label="agree to terms"
                checked={field.value || false}
                onChange={(e) => field.onChange(e.target.checked)}
              />
            </label>
          )}
        />
      );
    },
  };
});

import RegisterView from './register-view';

const returnTo = '/auth/accept-invite?id=abc-123';

function renderView(overrides: Partial<React.ComponentProps<typeof RegisterView>> = {}) {
  const props = {
    finalizeRegistration: vi.fn(),
    registerWithGithub: vi.fn().mockResolvedValue(undefined),
    registerWithGoogle: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const utils = render(<RegisterView {...props} />);
  return { props, ...utils };
}

describe('RegisterView — return_to threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes returnTo to the Google OAuth action', () => {
    const { props, getByText } = renderView({ returnTo });

    fireEvent.click(getByText('auth.register.registerWithGoogle'));

    expect(props.registerWithGoogle).toHaveBeenCalledWith(returnTo);
  });

  it('passes returnTo to the GitHub OAuth action', () => {
    const { props, getByText } = renderView({ returnTo });

    fireEvent.click(getByText('auth.register.registerWithGitHub'));

    expect(props.registerWithGithub).toHaveBeenCalledWith(returnTo);
  });

  it('keeps returnTo on the sign-in link', () => {
    const { getByText } = renderView({ returnTo });

    const link = getByText('auth.register.signInLink').closest('a');
    expect(link?.getAttribute('href')).toBe(
      `/auth/login?return_to=${encodeURIComponent(returnTo)}`
    );
  });

  it('links to plain login when no returnTo is set', () => {
    const { getByText } = renderView();

    const link = getByText('auth.register.signInLink').closest('a');
    expect(link?.getAttribute('href')).toBe('/auth/login');
  });
});

describe('RegisterView — server-side submit errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps field values and shows the alert when registration fails server-side', async () => {
    const finalizeRegistration = vi
      .fn()
      .mockResolvedValue({ error: 'Password is known to be compromised' });
    // The test-suite's global `../routes/paths` mock has no `orgs` entry (only
    // `auth`/`dashboard`), so pass a returnTo to avoid the unrelated
    // `paths.orgs.root` fallback the component builds the redirect URL from.
    const { getByLabelText, findByTestId, getByText } = renderView({
      finalizeRegistration,
      returnTo: '/orgs',
    });

    // Values must pass the real zod schema so submit reaches the server action.
    fireEvent.change(getByLabelText('auth.register.firstNamePlaceholder'), { target: { value: 'Ada' } });
    fireEvent.change(getByLabelText('auth.register.lastNamePlaceholder'), { target: { value: 'Lovelace' } });
    fireEvent.change(getByLabelText('auth.register.emailPlaceholder'), { target: { value: 'ada@example.com' } });
    fireEvent.change(getByLabelText('auth.register.passwordPlaceholder'), { target: { value: 'TestPassword123!' } });
    fireEvent.click(getByLabelText('agree to terms'));
    fireEvent.click(getByText('auth.register.createButton'));

    const alert = await findByTestId('register-error-alert');
    expect(alert).toHaveTextContent('Password is known to be compromised');

    // The bug: reset() blanked all of these.
    expect(getByLabelText('auth.register.firstNamePlaceholder')).toHaveValue('Ada');
    expect(getByLabelText('auth.register.lastNamePlaceholder')).toHaveValue('Lovelace');
    expect(getByLabelText('auth.register.emailPlaceholder')).toHaveValue('ada@example.com');
    expect(getByLabelText('auth.register.passwordPlaceholder')).toHaveValue('TestPassword123!');
  });
});
