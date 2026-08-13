// @vitest-environment jsdom
/**
 * The device-login confirmation card — the only UI surface where a human
 * approves or denies a CLI's device-code login. A silently-dropped
 * approve/deny failure here leaves the user staring at a still-interactive
 * card while the CLI keeps polling a code that already resolved, or worse,
 * believing a login succeeded when the mint never happened.
 *
 * Seams mocked: the server actions (`../../actions`) and the snackbar
 * transport — everything else (state, the resolved-card swap, the app
 * picker) is real.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { enqueueSnackbarSpy, actionMocks } = vi.hoisted(() => ({
  enqueueSnackbarSpy: vi.fn(),
  actionMocks: {
    approveDeviceAuthAction: vi.fn(),
    denyDeviceAuthAction: vi.fn(),
  },
}));

vi.mock('../../actions', () => actionMocks);

vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarSpy }),
}));

import { DeviceLoginApproval } from '../device-login-approval';

const request = { requestId: 'req-1', userCode: 'AAAA-BBBB' };
const apps = [
  { id: 'app-1', name: 'Web' },
  { id: 'app-2', name: 'API' },
];

/** MUI lands the accessible name on the FormControl wrapper's aria-label via
 * InputLabel + labelId, so `getByRole('combobox', { name })` resolves it. */
function getAppTrigger(): HTMLElement {
  return screen.getByRole('combobox', { name: 'App' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeviceLoginApproval — rendering', () => {
  it('shows the user-entered code and defaults the app picker to the first app', () => {
    render(<DeviceLoginApproval request={request} apps={apps} />);
    expect(screen.getByText('AAAA-BBBB')).toBeInTheDocument();
    expect(getAppTrigger()).toHaveTextContent('Web');
  });

  it('disables Approve when there are no apps to scope the key to', () => {
    render(<DeviceLoginApproval request={request} apps={[]} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});

describe('DeviceLoginApproval — approve', () => {
  it('approves with the requestId and the currently selected app id', async () => {
    actionMocks.approveDeviceAuthAction.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(getAppTrigger());
    await userEvent.click(await screen.findByRole('option', { name: 'API' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(actionMocks.approveDeviceAuthAction).toHaveBeenCalledWith({
        requestId: 'req-1',
        appId: 'app-2',
      }),
    );
  });

  it('swaps to the terminal "approved" card and never calls deny', async () => {
    actionMocks.approveDeviceAuthAction.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Device approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
    expect(actionMocks.denyDeviceAuthAction).not.toHaveBeenCalled();
  });

  it('toasts the transport-level error message and stays interactive on a wrapper failure', async () => {
    actionMocks.approveDeviceAuthAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'You must hold trace.write on this app to approve a CLI login.' },
    });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith(
        'You must hold trace.write on this app to approve a CLI login.',
        { variant: 'error' },
      ),
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByText('Device approved')).not.toBeInTheDocument();
  });

  it('toasts the business-level failure message when the action succeeds but the request already resolved', async () => {
    actionMocks.approveDeviceAuthAction.mockResolvedValue({
      ok: true,
      data: { ok: false, errorCode: 'already_resolved', message: 'This code is no longer waiting for approval — it may have expired or already been used.' },
    });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith(
        'This code is no longer waiting for approval — it may have expired or already been used.',
        { variant: 'error' },
      ),
    );
    expect(screen.queryByText('Device approved')).not.toBeInTheDocument();
  });
});

describe('DeviceLoginApproval — deny', () => {
  it('denies with only the requestId, independent of the selected app', async () => {
    actionMocks.denyDeviceAuthAction.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() =>
      expect(actionMocks.denyDeviceAuthAction).toHaveBeenCalledWith({ requestId: 'req-1' }),
    );
    expect(actionMocks.approveDeviceAuthAction).not.toHaveBeenCalled();
  });

  it('swaps to the terminal "denied" card', async () => {
    actionMocks.denyDeviceAuthAction.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(await screen.findByText('Device login denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('toasts a deny failure and stays interactive', async () => {
    actionMocks.denyDeviceAuthAction.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'Something went wrong.' },
    });
    render(<DeviceLoginApproval request={request} apps={apps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() =>
      expect(enqueueSnackbarSpy).toHaveBeenCalledWith('Something went wrong.', { variant: 'error' }),
    );
    expect(screen.queryByText('Device login denied')).not.toBeInTheDocument();
  });
});
