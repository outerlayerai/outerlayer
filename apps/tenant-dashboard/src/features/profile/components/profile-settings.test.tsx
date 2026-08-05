// @vitest-environment jsdom
/**
 * The General tab's only tested behavior is the email-change callback
 * handling: the form itself is covered by profile-form's own tests.
 */
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./profile-form', () => ({ default: () => <div data-testid="profile-form" /> }));

const enqueueSnackbar = vi.hoisted(() => vi.fn());
vi.mock('@/components/snackbar', () => ({ useSnackbar: () => ({ enqueueSnackbar }) }));

vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

import ProfileSettings from './profile-settings';

beforeEach(() => {
  enqueueSnackbar.mockClear();
  window.history.replaceState({}, '', '/profile');
});

describe('ProfileSettings', () => {
  it('shows the success snackbar and strips both query params without a navigation', () => {
    // proves AC-9
    window.history.replaceState({}, '', '/profile?email_change=success&email_error=ignored');

    render(<ProfileSettings emailChangeStatus="success" emailChangeError="ignored" />);

    expect(enqueueSnackbar).toHaveBeenCalledWith(
      'dashboard.profileSettings.emailChangeVerified',
      expect.objectContaining({ variant: 'success', autoHideDuration: 8000 }),
    );
    const url = new URL(window.location.href);
    expect(url.searchParams.has('email_change')).toBe(false);
    expect(url.searchParams.has('email_error')).toBe(false);
  });

  it('shows the expired-link message for email_error=expired', () => {
    // proves AC-10
    render(<ProfileSettings emailChangeStatus="error" emailChangeError="expired" />);
    expect(enqueueSnackbar).toHaveBeenCalledWith(
      'dashboard.profileSettings.emailChangeErrors.expired',
      expect.objectContaining({ variant: 'error', autoHideDuration: 8000 }),
    );
  });

  it('shows the already-used message for email_error=already_used', () => {
    // proves AC-10
    render(<ProfileSettings emailChangeStatus="error" emailChangeError="already_used" />);
    expect(enqueueSnackbar).toHaveBeenCalledWith(
      'dashboard.profileSettings.emailChangeErrors.alreadyUsed',
      expect.objectContaining({ variant: 'error', autoHideDuration: 8000 }),
    );
  });

  it('falls back to the unknown message for an unrecognised email_error value', () => {
    // proves AC-10
    render(<ProfileSettings emailChangeStatus="error" emailChangeError="something-else" />);
    expect(enqueueSnackbar).toHaveBeenCalledWith(
      'dashboard.profileSettings.emailChangeErrors.unknown',
      expect.objectContaining({ variant: 'error', autoHideDuration: 8000 }),
    );
  });

  it('shows no snackbar and does not touch the URL when there is no email_change param', () => {
    window.history.replaceState({}, '', '/profile');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    render(<ProfileSettings />);

    expect(enqueueSnackbar).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
    replaceStateSpy.mockRestore();
  });
});
