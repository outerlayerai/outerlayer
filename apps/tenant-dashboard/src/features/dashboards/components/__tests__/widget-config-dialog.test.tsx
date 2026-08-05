// @vitest-environment jsdom
/**
 * WidgetConfigDialog Component Tests
 *
 * Tests rendering and interaction of the widget configuration dialog.
 * Test names follow "should [outcome] when [condition]"
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, createTheme } from '@mui/material/styles';

function renderSelectOptions(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child, index) => {
    if (!React.isValidElement(child)) {
      return child;
    }

    const childProps = child.props as { children?: React.ReactNode; value?: string; disabled?: boolean };

    if (child.type === React.Fragment) {
      return renderSelectOptions(childProps.children);
    }

    return (
      <option
        key={child.key ?? index}
        value={childProps.value ?? ''}
        disabled={childProps.disabled}
      >
        {childProps.children}
      </option>
    );
  });
}

// ---------------------------------------------------------------------------
// MUI component mocks — Dialog and TextField (via Select) both import
// @mui/utils/getActiveElement which fails to resolve in Jest with MUI 7.x.
// Mock the problematic components with simplified versions.
// ---------------------------------------------------------------------------

vi.mock('@mui/material/Dialog', () => ({
  __esModule: true,
  default: ({ open, children }: any) =>
    open ? <div data-testid="mock-dialog">{children}</div> : null,
}));

vi.mock('@mui/material/DialogTitle', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@mui/material/DialogContent', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@mui/material/DialogActions', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@mui/material/TextField', () => ({
  __esModule: true,
  default: ({ label, select, children, size, sx, defaultValue, ...rest }: any) => (
    <div>
      <label>{label}</label>
      {select ? (
        <select aria-label={label} defaultValue={defaultValue} {...rest}>
          {renderSelectOptions(children)}
        </select>
      ) : (
        <input aria-label={label} defaultValue={defaultValue} {...rest} />
      )}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mocks — must come before component import
// ---------------------------------------------------------------------------

// Override the global hook-form mock with real react-hook-form for this test
// since we need useFieldArray and actual form behavior
vi.mock('@/components/hook-form', () => {
  const React = require('react');
  const { useFormContext } = require('react-hook-form');

  return {
    __esModule: true,
    default: ({ children, methods, onSubmit }: any) => {
      const { FormProvider } = require('react-hook-form');
      return (
        <FormProvider {...methods}>
          <form onSubmit={onSubmit}>{children}</form>
        </FormProvider>
      );
    },
    RHFTextField: ({ name, label, helperText }: any) => {
      const { register } = useFormContext();
      return (
        <div>
          <label htmlFor={name}>{label}</label>
          <input id={name} {...register(name)} aria-label={label} />
          {helperText && <span>{helperText}</span>}
        </div>
      );
    },
    RHFSelect: ({ name, label, children }: any) => {
      const { register } = useFormContext();
      return (
        <div>
          <label htmlFor={name}>{label}</label>
          <select id={name} {...register(name)} aria-label={label}>
            {renderSelectOptions(children)}
          </select>
        </div>
      );
    },
  };
});

vi.mock('../context', () => ({
  useDashboardContext: () => ({
    appId: 'app-123',
  }),
}));

// The add-widget submit calls the `addWidget` server action directly (no
// route survives behind it) — mocked at the module boundary so the dialog's
// submit handler is exercised without a real ServiceContext/DB.
const { addWidgetActionMock } = vi.hoisted(() => ({
  addWidgetActionMock: vi.fn(),
}));
vi.mock('../../actions', () => ({
  addWidget: addWidgetActionMock,
}));

import { waitFor } from '@testing-library/react';
import { WidgetConfigDialog } from '../widget-config-dialog';
import type { Widget } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const theme = createTheme();

interface RenderDialogOptions {
  open?: boolean;
  onClose?: () => void;
  onCreated?: (widget: Widget) => void;
}

function renderDialog(options: RenderDialogOptions = {}) {
  const {
    open = true,
    onClose = vi.fn(),
    onCreated = vi.fn(),
  } = options;

  return {
    ...render(
      <ThemeProvider theme={theme}>
        <WidgetConfigDialog
          open={open}
          onClose={onClose}
          dashboardId="dash-1"
          onCreated={onCreated}
        />
      </ThemeProvider>
    ),
    onClose,
    onCreated,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WidgetConfigDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render dialog title when open', () => {
    renderDialog();
    // "Add Widget" appears in both dialog title and submit button
    const addWidgetElements = screen.getAllByText('Add Widget');
    expect(addWidgetElements.length).toBe(2);
  });

  it('should render core form fields when dialog is open', () => {
    renderDialog();

    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Metric')).toBeInTheDocument();
    expect(screen.getByLabelText('Visualization')).toBeInTheDocument();
  });

  it('should reveal the Score Name field when a score-outcome-correlation metric is selected, and hide it for other metrics', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByLabelText('Score Name')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Metric'), 'agent_pr_outcome_by_score_merge_rate');
    expect(screen.getByLabelText('Score Name')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Metric'), 'request_count');
    expect(screen.queryByLabelText('Score Name')).not.toBeInTheDocument();
  });

  it('should tell the user worker.ci_green IS usable here (it writes Source: ci, not outcome) and only worker.merged/reverted are excluded', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText('Metric'), 'agent_pr_outcome_by_score_merge_rate');

    expect(screen.getByText(/worker\.ci_green \(first-pass CI\)/)).toBeInTheDocument();
    expect(screen.getByText(/worker\.merged and worker\.reverted can.t be used here/)).toBeInTheDocument();
  });

  it('should render filter and grouping fields when dialog is open', () => {
    renderDialog();

    expect(screen.getByLabelText('Group By')).toBeInTheDocument();
    expect(screen.getByLabelText('Time Granularity')).toBeInTheDocument();
    expect(screen.getByText('Filters')).toBeInTheDocument();
    expect(screen.getByText('Add Filter')).toBeInTheDocument();
  });

  it('should render "No filters applied" when no filters exist', () => {
    renderDialog();
    expect(screen.getByText('No filters applied')).toBeInTheDocument();
  });

  it('should add a filter row when Add Filter button is clicked', async () => {
    renderDialog();

    const addButton = screen.getByText('Add Filter');
    await userEvent.click(addButton);

    // After adding, "No filters applied" should disappear
    expect(screen.queryByText('No filters applied')).toBeNull();

    // Filter row fields should appear (Field, Operator, Value labels in the row)
    const fieldLabels = screen.getAllByText('Field');
    expect(fieldLabels.length).toBeGreaterThan(0);
  });

  it('should render Cancel and submit buttons when dialog is open', () => {
    renderDialog();

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    // Submit button text (when not submitting)
    const submitButtons = screen.getAllByRole('button');
    const addWidgetButton = submitButtons.find(
      (btn) => btn.textContent === 'Add Widget'
    );
    expect(addWidgetButton).toBeInTheDocument();
  });

  it('should call onClose when Cancel is clicked', async () => {
    const { onClose } = renderDialog();

    await userEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should not render dialog content when open is false', () => {
    renderDialog({ open: false });

    expect(screen.queryByText('Add Widget')).toBeNull();
  });

  it('should not render any environment selector — widgets always inherit the header env', () => {
    renderDialog();

    // There is no per-widget env selector: widgets follow the dashboard's
    // header environment, with no override path.
    expect(screen.queryByLabelText('Environment')).toBeNull();
    expect(screen.queryByText('Inherit from header env')).toBeNull();
    expect(
      screen.queryByText('Override with specific environment(s)')
    ).toBeNull();

    // The surrounding fields are untouched.
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Time Granularity')).toBeInTheDocument();
  });

  it('should call onCreated with the widget the create request returned, not just fire a bare callback', async () => {
    const createdWidget = {
      id: 'w-new',
      dashboardId: 'dash-1',
      title: 'My Widget',
      metric: 'request_count',
      visualization: 'line',
      filters: [],
      groupBy: null,
      timeGranularity: 'auto',
      createdAt: '2026-01-01',
      updatedAt: null,
    };
    addWidgetActionMock.mockResolvedValueOnce({ ok: true, data: createdWidget });

    const { onCreated } = renderDialog();

    await userEvent.type(screen.getByLabelText('Title'), 'My Widget');
    await userEvent.selectOptions(screen.getByLabelText('Metric'), 'request_count');

    const submitButtons = screen.getAllByRole('button');
    const addWidgetButton = submitButtons.find((btn) => btn.textContent === 'Add Widget')!;
    await userEvent.click(addWidgetButton);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(createdWidget);
    });
  });
});
