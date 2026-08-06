// @vitest-environment jsdom
/**
 * PermissionPicker Tests
 *
 * Tests prerequisite enforcement: auto-enable on check and cascade-disable
 * on uncheck, including group-level toggles.
 *
 * Note: app.read and agents.sessions.self.read are implicitly granted to all
 * custom roles (IMPLICIT_DB_PERMISSIONS), so neither App Access nor an
 * "own agent sessions" toggle appears in the picker.
 *
 * Every PREREQUISITES row today is single-level (the entry and its
 * prerequisite share a group — e.g. context_manage requires context_view).
 * No entry in the current permission model chains two levels deep, so the
 * recursive getAllPrerequisites/getAllDependents walk (BFS over
 * PREREQUISITES) has no 2+ level fixture to exercise the multi-hop path —
 * the walk is still real code, just untested past depth one.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Each interaction test renders the FULL picker (dozens of MUI Checkbox/Tooltip
// nodes). Elements are resolved with getByLabelText (a direct label lookup) rather
// than getByRole({ name }), which runs computeAccessibleName across every checkbox
// in the tree — that O(n) accessible-name pass was the dominant per-test CPU cost
// and, under an oversubscribed parallel CI worker, starved the test past its
// timeout. The full render is still non-trivial, so keep generous headroom for CI
// contention (where the testTimeout timer itself fires late under CPU starvation).
vi.setConfig({ testTimeout: 15000 });

// ---------------------------------------------------------------------------
// MUI barrel mock — override Accordion/AccordionDetails so AccordionDetails
// are always rendered (not collapsed), making individual permission checkboxes
// accessible in tests. Other MUI components use real implementations.
// ---------------------------------------------------------------------------

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual('@mui/material');
  return {
    ...(actual as Record<string, unknown>),
    Accordion: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AccordionSummary: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AccordionDetails: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    Tooltip: ({
      children,
      title,
    }: {
      children: React.ReactNode;
      title?: React.ReactNode;
    }) => (
      <span title={typeof title === 'string' ? title : undefined}>
        {children}
      </span>
    ),
  };
});

// Import after mocks
import {
  PermissionPicker,
  getAllPrerequisites,
  getAllDependents,
  REVERSE_DEPS,
} from './permission-picker';

// userEvent's default inter-event delay uses setTimeout. Under the parallel CI
// suite the event loop is starved, so those timers fire late and a single click
// can blow past the testTimeout — and a timed-out test skips its teardown,
// leaking its render into the next test ("Found multiple elements"). delay:null
// drops the timers, keeping interactions fast and load-independent.
const FAST_USER_EVENT = { delay: null } as const;

// ---------------------------------------------------------------------------
// Helper: render picker with controlled state
// ---------------------------------------------------------------------------

function renderPicker(
  initialPermissions: string[] = [],
  activeEntitlements?: Set<string>
) {
  const onChange = vi.fn();
  const utils = render(
    <PermissionPicker
      selectedPermissions={initialPermissions}
      onChange={onChange}
      activeEntitlements={activeEntitlements}
    />
  );
  return { ...utils, onChange };
}

// ---------------------------------------------------------------------------
// Pure logic: getAllPrerequisites
// ---------------------------------------------------------------------------

describe('getAllPrerequisites', () => {
  it('should return empty array for permission with no prerequisites', () => {
    expect(getAllPrerequisites('observability_view')).toEqual([]);
    expect(getAllPrerequisites('context_view')).toEqual([]);
  });

  it('should return direct prerequisites for context_manage', () => {
    const prereqs = getAllPrerequisites('context_manage');
    expect(prereqs).toContain('context_view');
    expect(prereqs).toHaveLength(1);
  });

  it('should return direct prerequisites for workers_manage', () => {
    const prereqs = getAllPrerequisites('workers_manage');
    expect(prereqs).toContain('workers_view');
    expect(prereqs).toHaveLength(1);
  });

  it('should return prerequisites for api_keys_create', () => {
    const prereqs = getAllPrerequisites('api_keys_create');
    expect(prereqs).toContain('api_keys_view');
    expect(prereqs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pure logic: getAllDependents
// ---------------------------------------------------------------------------

describe('getAllDependents', () => {
  it('should return empty array for permission with no dependents', () => {
    expect(getAllDependents('context_manage')).toEqual([]);
    expect(getAllDependents('workers_manage')).toEqual([]);
  });

  it('should return direct dependents of context_view', () => {
    const deps = getAllDependents('context_view');
    expect(deps).toEqual(['context_manage']);
  });

  it('should return direct dependents of workers_view', () => {
    const deps = getAllDependents('workers_view');
    expect(deps).toEqual(['workers_manage']);
  });

  it('should return transitive dependents of api_keys_view', () => {
    const deps = getAllDependents('api_keys_view');
    expect(deps).toContain('api_keys_create');
    expect(deps).toContain('api_keys_revoke');
  });
});

// ---------------------------------------------------------------------------
// Pure logic: REVERSE_DEPS
// ---------------------------------------------------------------------------

describe('REVERSE_DEPS', () => {
  it('should map context_view to context_manage', () => {
    expect(REVERSE_DEPS['context_view']).toContain('context_manage');
  });

  it('should map workers_view to workers_manage', () => {
    expect(REVERSE_DEPS['workers_view']).toContain('workers_manage');
  });

  it('should not have entries for permissions with no dependents', () => {
    expect(REVERSE_DEPS['context_manage']).toBeUndefined();
    expect(REVERSE_DEPS['workers_manage']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Component: auto-enable prerequisites on check
// ---------------------------------------------------------------------------

describe('PermissionPicker - prerequisite auto-enable', () => {
  it('should auto-enable prerequisite when checking a dependent permission', async () => {
    const user = userEvent.setup(FAST_USER_EVENT);
    const { onChange } = renderPicker([]);

    // context_manage requires context_view
    const manageCheckbox = screen.getByLabelText(/edit context files/i);
    await user.click(manageCheckbox);

    expect(onChange).toHaveBeenCalledTimes(1);
    const result = onChange.mock.calls[0]![0] as string[];
    expect(result).toContain('context_manage');
    expect(result).toContain('context_view');
  });

  it('should not duplicate already-selected permissions when auto-enabling', async () => {
    const user = userEvent.setup(FAST_USER_EVENT);
    const { onChange } = renderPicker(['context_view']);

    const manageCheckbox = screen.getByLabelText(/edit context files/i);
    await user.click(manageCheckbox);

    const result = onChange.mock.calls[0]![0] as string[];
    const contextViewCount = result.filter((p) => p === 'context_view').length;
    expect(contextViewCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Component: locked prerequisites (visual feedback)
// ---------------------------------------------------------------------------

describe('PermissionPicker - locked prerequisites', () => {
  it('should disable the checkbox for a permission required by a selected dependent', () => {
    // context_manage is selected → context_view must be locked
    renderPicker(['context_view', 'context_manage']);

    const contextViewCheckbox = screen.getByLabelText(/view context files/i);
    expect(contextViewCheckbox).toBeDisabled();
  });

  it('should not disable the checkbox when no dependents are selected', () => {
    // Only context_view selected, no context_manage → not locked
    renderPicker(['context_view']);

    const contextViewCheckbox = screen.getByLabelText(/view context files/i);
    expect(contextViewCheckbox).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Component: group toggle respects prerequisites
// ---------------------------------------------------------------------------

describe('PermissionPicker - group toggle with prerequisites', () => {
  it('should auto-enable prerequisites when checking a permission via group toggle', async () => {
    const user = userEvent.setup(FAST_USER_EVENT);
    const { onChange } = renderPicker([]);

    // api_keys_create requires api_keys_view
    const createKeyCheckbox = screen.getByLabelText(/create api keys/i);
    await user.click(createKeyCheckbox);

    const result = onChange.mock.calls[0]![0] as string[];
    expect(result).toContain('api_keys_create');
    expect(result).toContain('api_keys_view');
  });
});
