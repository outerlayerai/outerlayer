// @vitest-environment jsdom
/**
 * ProfileForm covers two independent save paths: name/avatar go straight to
 * `updateProfile` with no confirmation step, while an email change is routed
 * through Supabase Auth's double-confirmation flow and the displayed field
 * is reverted to the still-current address until that confirmation lands.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ControllerRenderProps } from 'react-hook-form';

vi.mock('@/components/settings-shell', () => ({
  SettingsSection: ({ children, footer }: any) => (
    <div>
      <div data-testid="section-body">{children}</div>
      {footer && <div data-testid="section-footer">{footer.action}</div>}
    </div>
  ),
}));

vi.mock('@/components/hook-form', () => {
  const { Controller, useFormContext, FormProvider: RHFFormProvider } = require('react-hook-form');
  return {
    __esModule: true,
    default: ({ children, methods, onSubmit }: any) => (
      <RHFFormProvider {...methods}>
        <form onSubmit={onSubmit}>{children}</form>
      </RHFFormProvider>
    ),
    RHFTextField: ({ name, label }: any) => {
      const { control } = useFormContext();
      return (
        <Controller
          name={name}
          control={control}
          render={({ field, fieldState: { error } }: { field: ControllerRenderProps; fieldState: any }) => (
            <>
              <input {...field} value={field.value ?? ''} aria-label={label} />
              {error && <span role="alert">{error.message}</span>}
            </>
          )}
        />
      );
    },
    RHFUploadAvatar: ({ name, onDrop }: any) => {
      const { control } = useFormContext();
      return (
        <Controller
          name={name}
          control={control}
          render={() => (
            <input
              type="file"
              aria-label="dashboard.profileSettings.avatarUpload"
              onChange={(e: any) => {
                const file = e.target.files?.[0];
                if (file) onDrop([file]);
              }}
            />
          )}
        />
      );
    },
  };
});

const { enqueueSnackbarMock } = vi.hoisted(() => ({ enqueueSnackbarMock: vi.fn() }));
vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }),
}));

const { updateProfileMock } = vi.hoisted(() => ({ updateProfileMock: vi.fn() }));
vi.mock('../../../hooks/use-profile', () => ({
  useProfile: () => ({
    profile: { name: 'Ada Lovelace', avatar_url: 'https://existing-avatar.example/a.png' },
    updateProfile: updateProfileMock,
  }),
}));

const { updateEmailMock } = vi.hoisted(() => ({ updateEmailMock: vi.fn() }));
vi.mock('@/auth/hooks', () => ({
  useAuthContext: () => ({
    user: { email: 'ada@example.com', role: 'member' },
    updateEmail: updateEmailMock,
  }),
}));

import ProfileForm from './profile-form';

function getNameField() {
  return screen.getByLabelText('dashboard.profileSettings.namePlaceholder');
}

function getEmailField() {
  return screen.getByLabelText('dashboard.profileSettings.emailPlaceholder');
}

function getSaveButton() {
  return screen.getByRole('button', { name: /dashboard.profileSettings.saveButton/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateProfileMock.mockResolvedValue(undefined);
  updateEmailMock.mockResolvedValue({ success: true });
});

describe('ProfileForm — name/avatar save immediately', () => {
  it('submits the changed name and avatar to updateProfile and shows the success toast', async () => {
    // proves AC-079-01
    render(<ProfileForm />);

    await userEvent.clear(getNameField());
    await userEvent.type(getNameField(), 'Grace Hopper');

    const avatarFile = new File(['binary'], 'avatar.png', { type: 'image/png' });
    await userEvent.upload(
      screen.getByLabelText('dashboard.profileSettings.avatarUpload'),
      avatarFile,
    );

    await userEvent.click(getSaveButton());

    await waitFor(() => {
      expect(updateProfileMock).toHaveBeenCalledWith({
        name: 'Grace Hopper',
        avatar_url: avatarFile,
      });
    });
    // No email change on this path, so updateEmail is never invoked and no
    // confirmation step is triggered.
    expect(updateEmailMock).not.toHaveBeenCalled();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('dashboard.profileSettings.successNotification');
  });

  it('shows an error toast instead of a success toast when the update fails', async () => {
    // proves AC-079-01
    updateProfileMock.mockRejectedValueOnce(new Error('Permission denied: profile.update'));
    render(<ProfileForm />);

    await userEvent.clear(getNameField());
    await userEvent.type(getNameField(), 'Grace Hopper');
    await userEvent.click(getSaveButton());

    await waitFor(() => {
      expect(enqueueSnackbarMock).toHaveBeenCalledWith('Permission denied: profile.update', {
        variant: 'error',
      });
    });
    expect(enqueueSnackbarMock).not.toHaveBeenCalledWith(
      'dashboard.profileSettings.successNotification',
    );
  });
});

describe('ProfileForm — email change requires confirmation', () => {
  it('does not swap the displayed email immediately; shows the pending-confirmation toast instead', async () => {
    // proves AC-079-02
    render(<ProfileForm />);

    await userEvent.clear(getEmailField());
    await userEvent.type(getEmailField(), 'ada.new@example.com');
    await userEvent.click(getSaveButton());

    await waitFor(() => {
      expect(updateEmailMock).toHaveBeenCalledWith('ada.new@example.com');
    });
    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      'dashboard.profileSettings.emailChangeSuccess',
      expect.objectContaining({ variant: 'success', autoHideDuration: 8000 }),
    );
    // The field reverts to the still-current address — the new one only takes
    // effect once the confirmation link is used, not on submit.
    await waitFor(() => {
      expect(getEmailField()).toHaveValue('ada@example.com');
    });
    expect(enqueueSnackbarMock).not.toHaveBeenCalledWith(
      'dashboard.profileSettings.successNotification',
    );
  });

  it('reverts the field and surfaces the typed error when Supabase rejects the email change', async () => {
    // proves AC-079-02
    updateEmailMock.mockResolvedValueOnce({ success: false, errorCode: 'email_exists' });
    render(<ProfileForm />);

    await userEvent.clear(getEmailField());
    await userEvent.type(getEmailField(), 'taken@example.com');
    await userEvent.click(getSaveButton());

    await waitFor(() => {
      expect(enqueueSnackbarMock).toHaveBeenCalledWith(
        'dashboard.profileSettings.emailChangeErrors.email_exists',
        { variant: 'error' },
      );
    });
    await waitFor(() => {
      expect(getEmailField()).toHaveValue('ada@example.com');
    });
  });
});
