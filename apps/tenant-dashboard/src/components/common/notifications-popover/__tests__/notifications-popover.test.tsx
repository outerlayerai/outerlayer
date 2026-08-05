// @vitest-environment jsdom
/**
 * Notifications-drawer UI contract. These assertions describe the
 * RESTYLED drawer (text "Mark all as read" button, empty state, in-flow unread
 * dots), so they ship with the restyle. They pin:
 *   - "Mark all as read" is a text button shown only when unread > 0, wired to
 *     update({read:true});
 *   - the empty state renders "You're all caught up" (and no rows) when there
 *     are no notifications;
 *   - a populated drawer renders one row per notification with an unread dot on
 *     unread rows.
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Notification } from '../../../../types/notification';

const markAllSpy = vi.hoisted(() => vi.fn());
const queryState = vi.hoisted(() => ({ count: 0, data: [] as Notification[] }));

vi.mock('../../../../hooks/use-boolean', async (importOriginal) =>
  importOriginal(),
);

vi.mock('../../../../auth/hooks', () => ({
  // The notification policy answers for every org the caller belongs to;
  // this component narrows to the org on screen. `tenant` deliberately
  // carries a DIFFERENT tenant id to prove the component reads
  // `activeTenant`.
  useAuthContext: () => ({
    user: { id: 'u1', tenant: { tenant_id: 'stale-tenant' }, activeTenant: { tenant_id: 't1' } },
  }),
}));

const matchSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../../supabaseFrontendClient', () => ({
  createSupabaseFontendClient: () => ({
    channel: () => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    },
    removeChannel: vi.fn(),
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'eq', 'single']) {
        chain[m] = vi.fn(() => chain);
      }
      chain.match = vi.fn((arg: unknown) => {
        matchSpy(arg);
        return chain;
      });
      chain.update = vi.fn((arg: unknown) => {
        markAllSpy(arg);
        return chain;
      });
      chain.then = (onF: (v: unknown) => unknown) =>
        Promise.resolve({
          count: queryState.count,
          data: queryState.data,
          error: null,
        }).then(onF);
      return chain;
    },
  }),
}));

import NotificationsPopover from '..';

function makeNotification(overrides: Partial<Notification>): Notification {
  return {
    id: 'n1',
    message: 'Deploy finished',
    created_at: '2026-01-02T10:30:00.000Z',
    read: false,
    tenant_id: 't1',
    type: 'warning',
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

async function openDrawer() {
  await act(async () => {
    render(<NotificationsPopover />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'notifications' }));
  await screen.findByText('Notifications');
}

beforeEach(() => {
  markAllSpy.mockClear();
  matchSpy.mockClear();
  queryState.count = 0;
  queryState.data = [];
});

// The server-side notification set is narrowed client-side to the URL org
// via activeTenant (reactive to navigation), never the stale `tenant` field.
describe('NotificationsPopover — filters to the URL org, not a stale tenant', () => {
  it('scopes every notification query to activeTenant.tenant_id', async () => {
    await openDrawer();

    await waitFor(() => expect(matchSpy.mock.calls.length).toBeGreaterThan(0));
    for (const call of matchSpy.mock.calls) {
      expect(call[0]).toMatchObject({ tenant_id: 't1' });
    }
  });
});

describe('NotificationsPopover mark-all-as-read', () => {
  it('shows a "Mark all as read" text button when unread > 0 and wires it to update({read:true})', async () => {
    queryState.count = 3;
    queryState.data = [
      makeNotification({ id: 'a', read: false }),
      makeNotification({ id: 'b', read: false }),
      makeNotification({ id: 'c', read: false }),
    ];
    await openDrawer();

    const button = await screen.findByRole('button', { name: 'Mark all as read' });
    fireEvent.click(button);

    await waitFor(() => expect(markAllSpy).toHaveBeenCalledWith({ read: true }));
  });

  it('hides the "Mark all as read" button when there are no unread notifications', async () => {
    queryState.count = 0;
    queryState.data = [makeNotification({ id: 'a', read: true })];
    await openDrawer();

    await screen.findByText('Deploy finished');
    expect(
      screen.queryByRole('button', { name: 'Mark all as read' }),
    ).toBeNull();
  });
});

describe('NotificationsPopover list rendering', () => {
  it('renders the empty state and no rows when there are no notifications', async () => {
    await openDrawer();

    expect(await screen.findByText(/You're all caught up/)).toBeInTheDocument();
    expect(screen.queryByTestId('notification-unread-dot')).toBeNull();
  });

  it('renders one row per notification with an unread dot on unread rows', async () => {
    queryState.count = 1;
    queryState.data = [
      makeNotification({ id: 'a', message: 'First notice', read: false }),
      makeNotification({ id: 'b', message: 'Second notice', read: true }),
    ];
    await openDrawer();

    expect(await screen.findByText('First notice')).toBeInTheDocument();
    expect(screen.getByText('Second notice')).toBeInTheDocument();
    // Exactly one row is unread → exactly one dot.
    expect(screen.getAllByTestId('notification-unread-dot')).toHaveLength(1);
  });
});
