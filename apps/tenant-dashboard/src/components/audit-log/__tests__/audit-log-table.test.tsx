// @vitest-environment jsdom
/**
 * <AuditLogTable> — the shared presentational trail list (platform-admin +
 * tenant surfaces). The injected fetchPage is the scoping seam, so the tests
 * pin exactly what the component ASKS FOR (page, size, filters, date bounds)
 * and how it renders what comes back (actor fallback chain, action labels,
 * targets, error/empty states).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AuditLogTable, type AuditLogFilterOption } from '../audit-log-table';
import type {
  ActionType,
  TargetType,
  AuditLogListItem,
  PaginatedResponse,
} from '../../../types/platform-admin';

const ACTION_TYPES: AuditLogFilterOption<ActionType>[] = [
  { value: '', label: 'All Actions' },
  { value: 'member_role_changed', label: 'Member Role Changed' },
];
const TARGET_TYPES: AuditLogFilterOption<TargetType>[] = [
  { value: '', label: 'All Targets' },
  { value: 'membership', label: 'Membership' },
];

function makeItem(overrides: Partial<AuditLogListItem> = {}): AuditLogListItem {
  return {
    id: 'log-1',
    actor_id: 'user-1',
    actor_type: 'human',
    actor_label: 'admin@acme.co',
    actor_email: 'admin@acme.co',
    actor_name: 'Admin One',
    tenant_id: 'tenant-1',
    action_type: 'member_role_changed',
    target_type: 'membership',
    target_id: 'mem-1',
    target_identifier: 'member@acme.co',
    created_at: '2026-07-09T10:00:00.000Z',
    details_preview: null,
    ...overrides,
  };
}

function pageOf(items: AuditLogListItem[]): PaginatedResponse<AuditLogListItem> {
  return { items, total: items.length, page: 1, pageSize: 25, totalPages: 1 };
}

describe('AuditLogTable', () => {
  it('fetches page 1 with no filters on mount and renders actor/action/target', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: pageOf([makeItem()]) });

    render(
      <AuditLogTable fetchPage={fetchPage} actionTypes={ACTION_TYPES} targetTypes={TARGET_TYPES} />
    );

    expect(await screen.findByText('admin@acme.co')).toBeInTheDocument();
    expect(screen.getByText('Admin One')).toBeInTheDocument();
    expect(screen.getByText('Member Role Changed')).toBeInTheDocument();
    expect(screen.getByText('member@acme.co')).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledWith({
      page: 1,
      pageSize: 25,
      actionType: undefined,
      targetType: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it('falls back actor display to label then type when no profile resolves', async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      data: pageOf([
        makeItem({ id: 'l1', actor_email: null, actor_name: null, actor_label: 'ghost@x.co' }),
        makeItem({
          id: 'l2',
          actor_email: null,
          actor_name: null,
          actor_label: null,
          actor_type: 'gateway',
          target_identifier: 'other@x.co',
        }),
      ]),
    });

    render(
      <AuditLogTable fetchPage={fetchPage} actionTypes={ACTION_TYPES} targetTypes={TARGET_TYPES} />
    );

    expect(await screen.findByText('ghost@x.co')).toBeInTheDocument();
    expect(screen.getByText('gateway')).toBeInTheDocument();
  });

  it('refetches with the action filter and converts date inputs to ISO bounds', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: pageOf([makeItem()]) });
    render(
      <AuditLogTable fetchPage={fetchPage} actionTypes={ACTION_TYPES} targetTypes={TARGET_TYPES} />
    );
    await screen.findByText('admin@acme.co');

    // MUI select: open via the combobox, choose the option.
    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]!);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Member Role Changed'));
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ actionType: 'member_role_changed' })
      )
    );

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-07-08' } });
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          startDate: '2026-07-01T00:00:00.000Z',
          endDate: '2026-07-08T23:59:59.999Z',
        })
      )
    );
  });

  it('surfaces the detail callback with the clicked row id', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: pageOf([makeItem({ id: 'log-42' })]) });
    const onViewDetail = vi.fn();
    render(
      <AuditLogTable
        fetchPage={fetchPage}
        actionTypes={ACTION_TYPES}
        targetTypes={TARGET_TYPES}
        onViewDetail={onViewDetail}
      />
    );
    await screen.findByText('admin@acme.co');

    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(onViewDetail).toHaveBeenCalledWith('log-42');
  });

  it('renders the error state from a failed fetch and the empty label otherwise', async () => {
    const failing = vi.fn().mockResolvedValue({ error: 'The audit log requires an Enterprise plan' });
    const { unmount } = render(
      <AuditLogTable fetchPage={failing} actionTypes={ACTION_TYPES} targetTypes={TARGET_TYPES} />
    );
    expect(await screen.findByText('The audit log requires an Enterprise plan')).toBeInTheDocument();
    unmount();

    const empty = vi.fn().mockResolvedValue({ data: pageOf([]) });
    render(
      <AuditLogTable
        fetchPage={empty}
        actionTypes={ACTION_TYPES}
        targetTypes={TARGET_TYPES}
        emptyLabel="No audit entries yet"
      />
    );
    expect(await screen.findByText('No audit entries yet')).toBeInTheDocument();
  });

  it('renders RSC-seeded initialData without an initial client fetch', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: pageOf([]) });
    render(
      <AuditLogTable
        fetchPage={fetchPage}
        actionTypes={ACTION_TYPES}
        targetTypes={TARGET_TYPES}
        initialData={pageOf([makeItem({ id: 'seeded-log' })])}
      />
    );

    expect(await screen.findByText('admin@acme.co')).toBeInTheDocument();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('renders an RSC-seeded initialError without an initial client fetch, then still refetches on a filter change', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: pageOf([makeItem()]) });
    render(
      <AuditLogTable
        fetchPage={fetchPage}
        actionTypes={ACTION_TYPES}
        targetTypes={TARGET_TYPES}
        initialError="The audit log requires an Enterprise plan"
      />
    );

    expect(await screen.findByText('The audit log requires an Enterprise plan')).toBeInTheDocument();
    expect(fetchPage).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]!);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Member Role Changed'));

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
  });

  it('seeds page/filter controls from initialFilters', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: pageOf([makeItem()]) });
    render(
      <AuditLogTable
        fetchPage={fetchPage}
        actionTypes={ACTION_TYPES}
        targetTypes={TARGET_TYPES}
        initialData={pageOf([makeItem()])}
        initialFilters={{ page: 2, pageSize: 25, actionType: 'member_role_changed', fromDate: '2026-07-01', toDate: '2026-07-08' }}
      />
    );
    await screen.findByText('admin@acme.co');

    expect(screen.getByLabelText('From')).toHaveValue('2026-07-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-07-08');

    // A subsequent client-driven fetch (e.g. changing rows-per-page) carries
    // the seeded page/filters forward rather than resetting to page 1.
    fireEvent.mouseDown(screen.getAllByRole('combobox')[1]!);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Membership'));

    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, targetType: 'membership', actionType: 'member_role_changed' })
      )
    );
  });
});
