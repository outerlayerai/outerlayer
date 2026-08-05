// @vitest-environment jsdom
/**
 * Behavior-pinning for NotificationItem, written BEFORE the restyle
 * so the restyle can be proven to preserve the two behaviors this row has:
 *   1. click marks the row read — but ONLY when it is currently unread (the
 *      `if (!notification.read)` guard prevents a redundant write on read rows).
 *   2. the sanitized message keeps its embedded anchor — the message HTML is the
 *      only routing this surface has, so dropping the <a> breaks click-through.
 *
 * Complements xss-prevention.test.tsx, which pins the REMOVAL of unsafe markup;
 * this pins the PRESERVATION of the safe anchor.
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NotificationItem from '../notification-item';
import type { Notification } from '../../../../types/notification';

const { updateSpy, eqSpy } = vi.hoisted(() => {
  const eqSpy = vi.fn(() => Promise.resolve({ data: null, error: null }));
  const updateSpy = vi.fn(() => ({ eq: eqSpy }));
  return { updateSpy, eqSpy };
});

vi.mock('../../../../supabaseFrontendClient', () => ({
  createSupabaseFontendClient: () => ({
    from: () => ({ update: updateSpy }),
  }),
}));

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

beforeEach(() => {
  updateSpy.mockClear();
  eqSpy.mockClear();
});

describe('NotificationItem mark-as-read behavior', () => {
  it('does NOT write when an already-read row is clicked', () => {
    render(<NotificationItem notification={makeNotification({ read: true })} />);

    fireEvent.click(screen.getByRole('button'));

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('marks the row read (update({read:true}).eq("id", <id>)) when an unread row is clicked', async () => {
    render(
      <NotificationItem notification={makeNotification({ id: 'abc-123', read: false })} />,
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith({ read: true });
    expect(eqSpy).toHaveBeenCalledWith('id', 'abc-123');
  });
});

describe('NotificationItem message routing', () => {
  it('preserves an embedded anchor from the sanitized message HTML', () => {
    const { container } = render(
      <NotificationItem
        notification={makeNotification({
          message: '<a href="/apps/x">Open app</a>',
        })}
      />,
    );

    const anchor = container.querySelector('a[href="/apps/x"]');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveTextContent('Open app');
  });
});
