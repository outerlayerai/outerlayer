// @vitest-environment jsdom
/**
 * The org-scoped device-login approval page: renders the confirmation card
 * for a live user_code, or a terminal "no longer valid" message for
 * everything else (missing code, expired, already resolved) — the poll
 * route's own enumeration-safe collapsing, mirrored here so the page never
 * leaks which of those three actually happened.
 */

import { render, screen } from '@testing-library/react';

const readMocks = vi.hoisted(() => ({
  loadPendingDeviceAuthRequest: vi.fn(),
  loadAppsList: vi.fn(),
}));

vi.mock('@/features/device-auth/read', () => ({
  loadPendingDeviceAuthRequest: readMocks.loadPendingDeviceAuthRequest,
}));
vi.mock('@/features/apps/read', () => ({
  loadAppsList: readMocks.loadAppsList,
}));
vi.mock('@/features/device-auth/components/device-login-approval', () => ({
  DeviceLoginApproval: ({ request, apps }: { request: { userCode: string }; apps: { id: string; name: string }[] }) => (
    <div data-testid="approval-card">
      {request.userCode} / {apps.map((a) => a.name).join(',')}
    </div>
  ),
}));
vi.mock('../../../../../layouts/app/app-layout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import DeviceAuthPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  readMocks.loadAppsList.mockResolvedValue([
    { id: 'app-1', name: 'Web', otherField: 'ignored' },
  ]);
});

describe('DeviceAuthPage — org-scoped approval', () => {
  it('renders the approval card for a live pending request, passing only id/name for each app', async () => {
    readMocks.loadPendingDeviceAuthRequest.mockResolvedValue({ requestId: 'req-1', userCode: 'AAAA-BBBB' });

    const el = await DeviceAuthPage({ searchParams: Promise.resolve({ user_code: 'AAAA-BBBB' }) });
    render(el);

    expect(readMocks.loadPendingDeviceAuthRequest).toHaveBeenCalledWith('AAAA-BBBB');
    expect(screen.getByTestId('approval-card')).toHaveTextContent('AAAA-BBBB / Web');
  });

  it('renders the "no longer valid" state and skips the read entirely when no user_code is in the URL', async () => {
    const el = await DeviceAuthPage({ searchParams: Promise.resolve({}) });
    render(el);

    expect(readMocks.loadPendingDeviceAuthRequest).not.toHaveBeenCalled();
    expect(screen.getByText('This code is no longer valid')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument();
  });

  it('renders the "no longer valid" state when the code no longer resolves to a pending request', async () => {
    readMocks.loadPendingDeviceAuthRequest.mockResolvedValue(null);

    const el = await DeviceAuthPage({ searchParams: Promise.resolve({ user_code: 'ZZZZ-ZZZZ' }) });
    render(el);

    expect(screen.getByText('This code is no longer valid')).toBeInTheDocument();
  });
});
