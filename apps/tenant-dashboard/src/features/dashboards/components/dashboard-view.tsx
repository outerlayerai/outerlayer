'use client';

/**
 * Main dashboard view: header with time range selector,
 * "Add Widget" button, and a react-grid-layout grid for drag-and-drop widgets.
 */

import { useCallback, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import type { Layout } from 'react-grid-layout/core';
import 'react-grid-layout/css/styles.css';
import Iconify from '@/components/iconify';
import CustomPopover, { usePopover } from '@/components/custom-popover';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { useSnackbar } from '@/components/snackbar';
import { DashboardProvider, useDashboardContext, type DashboardTimeRange } from './context';
import { WidgetRenderer } from './widget-renderer';
import { WidgetConfigDialog } from './widget-config-dialog';
import { useDashboards } from '../hooks/use-dashboards';
import { deleteWidget } from '../actions';
import { appPaths } from '@/routes/paths';
import { useSelectedEnv } from "@/hooks/environments/use-selected-env";
import { MAX_WIDGETS_PER_DASHBOARD } from '../types';
import type { Dashboard, DashboardSummary, LayoutItem, Widget } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID_COLS = 12;
const ROW_HEIGHT = 80;
const GRID_MARGIN: readonly [number, number] = [16, 16];

// Header filter controls read as mono chips — the same micro-label register
// as the widget title bars.
const chipButtonSx = {
  fontFamily: (t: { typography: { fontFamilyMonospace: string } }) => t.typography.fontFamilyMonospace,
  fontSize: '0.6875rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'text.secondary',
} as const;

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Convert our LayoutItem[] to react-grid-layout's Layout format */
function toRGLLayout(items: LayoutItem[]): Layout {
  return items.map((item) => ({
    i: item.widgetId,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: 2,
    minH: 2,
  }));
}

/** Convert react-grid-layout's Layout back to our LayoutItem[] */
function fromRGLLayout(rglLayout: Layout): LayoutItem[] {
  return rglLayout.map((item) => ({
    widgetId: item.i,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  }));
}

/** Calculate the next available position for a new widget */
function calcNextPosition(layout: LayoutItem[], visualization: string): LayoutItem {
  const isStat = visualization === 'stat';
  const w = isStat ? 3 : 6;
  const h = isStat ? 2 : 4;

  // Find the bottom-most row
  const maxY = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);

  return { widgetId: '', x: 0, y: maxY, w, h };
}

// ---------------------------------------------------------------------------
// Dashboard Selector
// ---------------------------------------------------------------------------

function DashboardSelector({ initialDashboards }: { initialDashboards: DashboardSummary[] }) {
  const { dashboard, appId } = useDashboardContext();
  const { dashboards } = useDashboards({ appId, initialDashboards });
  const params = useParams<{ orgName: string; appName: string }>();
  const selectedEnv = useSelectedEnv();
  const router = useRouter();
  const popover = usePopover();

  const handleSelect = (dashboardId: string) => {
    popover.onClose();
    if (dashboardId !== dashboard?.id) {
      router.push(appPaths.dashboards.view(params.orgName, params.appName, selectedEnv.name, dashboardId));
    }
  };

  const handleManage = () => {
    popover.onClose();
    router.push(appPaths.dashboards.root(params.orgName, params.appName, selectedEnv.name));
  };

  if (!dashboard) return null;

  return (
    <>
      {/* The dashboard's own name is the page title; this stays a plain
          navigation affordance so the two don't compete for identity. */}
      <Button
        variant="text"
        size="small"
        color="inherit"
        onClick={popover.onOpen}
        endIcon={<Iconify icon="eva:chevron-down-fill" width={16} />}
        sx={{ textTransform: 'none', color: 'text.secondary' }}
      >
        Switch
      </Button>
      <CustomPopover open={popover.open} onClose={popover.onClose} sx={{ minWidth: 200 }}>
        {dashboards?.map((d) => (
          <MenuItem
            key={d.id}
            selected={d.id === dashboard.id}
            onClick={() => handleSelect(d.id)}
          >
            {d.name}
            {d.isDefault && (
              <Typography
                component="span"
                variant="caption"
                sx={{ ml: 1, color: 'text.secondary' }}
              >
                (Default)
              </Typography>
            )}
          </MenuItem>
        ))}
        <Divider sx={{ my: 0.5 }} />
        <MenuItem onClick={handleManage}>
          <Iconify icon="eva:settings-2-outline" width={18} sx={{ mr: 1 }} />
          Manage Dashboards
        </MenuItem>
      </CustomPopover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Time Range Selector
// ---------------------------------------------------------------------------

const TIME_RANGES: { value: DashboardTimeRange; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

function TimeRangeSelector() {
  const { timeRange, onTimeRangeChange } = useDashboardContext();
  const popover = usePopover();

  const current = TIME_RANGES.find((r) => r.value === timeRange);

  return (
    <>
      <Button variant="outlined" size="small" color="inherit" onClick={popover.onOpen} sx={chipButtonSx}>
        {current?.label ?? timeRange}
      </Button>
      <CustomPopover open={popover.open} onClose={popover.onClose}>
        {TIME_RANGES.map((range) => (
          <MenuItem
            key={range.value}
            selected={range.value === timeRange}
            onClick={() => {
              onTimeRangeChange(range.value);
              popover.onClose();
            }}
          >
            {range.label}
          </MenuItem>
        ))}
      </CustomPopover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Scope Selector — App vs Organization rollup
// ---------------------------------------------------------------------------

/**
 * Toggles the agent-fleet / PR metrics between the app's dominant repo (the
 * historical default) and a tenant-wide rollup — the Executive Overview's
 * questions are org-level, and a multi-repo org answering them from one
 * repo's numbers is exactly the silent-narrowing this makes explicit. Base
 * LLM metrics are app-scoped by construction and ignore it.
 */
function ScopeSelector() {
  const { scope, onScopeChange } = useDashboardContext();
  const popover = usePopover();

  const OPTIONS = [
    { value: 'app', label: 'This repo' },
    { value: 'org', label: 'Whole organization' },
  ] as const;
  const current = OPTIONS.find((o) => o.value === scope);

  return (
    <>
      <Button variant="outlined" size="small" color="inherit" onClick={popover.onOpen} sx={chipButtonSx}>
        {current?.label ?? scope}
      </Button>
      <CustomPopover open={popover.open} onClose={popover.onClose}>
        {OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            selected={option.value === scope}
            onClick={() => {
              onScopeChange(option.value);
              popover.onClose();
            }}
          >
            {option.label}
          </MenuItem>
        ))}
      </CustomPopover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Content (inside provider)
// ---------------------------------------------------------------------------

function DashboardContent({ initialDashboards }: { initialDashboards: DashboardSummary[] }) {
  const { dashboard, error, appId, addWidget, removeWidget, updateLayout } = useDashboardContext();
  const { width, containerRef } = useContainerWidth();
  const { enqueueSnackbar } = useSnackbar();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Build the RGL layout from dashboard data
  const rglLayout = useMemo(() => {
    if (!dashboard) return [];
    const widgetIds = new Set(dashboard.widgets.map((w) => w.id));

    // Use stored layout items that have matching widgets
    const validLayout = dashboard.layout.filter((l) => widgetIds.has(l.widgetId));

    // Add layout entries for widgets not in layout
    const layoutWidgetIds = new Set(validLayout.map((l) => l.widgetId));
    const missing = dashboard.widgets.filter((w) => !layoutWidgetIds.has(w.id));
    const fullLayout = [...validLayout];
    for (const w of missing) {
      const pos = calcNextPosition(fullLayout, w.visualization);
      fullLayout.push({ ...pos, widgetId: w.id });
    }

    return toRGLLayout(fullLayout);
  }, [dashboard]);

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      updateLayout(fromRGLLayout(newLayout));
    },
    [updateLayout]
  );

  const handleWidgetCreated = useCallback(
    (widget: Widget) => {
      addWidget(widget);
    },
    [addWidget]
  );

  const handleWidgetDelete = useCallback(
    async (widgetId: string) => {
      if (!dashboard) return;
      // Both failure shapes matter: the widget stays on the grid either way,
      // so an unreported failure reads as a successful delete that undid
      // itself on the next load.
      try {
        const result = await deleteWidget({ appId, dashboardId: dashboard.id, widgetId });
        if (result.ok) {
          removeWidget(widgetId);
        } else {
          enqueueSnackbar(result.error.message, { variant: 'error' });
        }
      } catch (err) {
        enqueueSnackbar(err instanceof Error ? err.message : 'Failed to delete widget', {
          variant: 'error',
        });
      }
    },
    [dashboard, appId, removeWidget, enqueueSnackbar]
  );

  // Single return — containerRef is always in the DOM so useContainerWidth's
  // ResizeObserver can measure the real width before the grid first renders.
  // Every branch below renders inside it, including the two that have no grid.
  return (
    <Box ref={containerRef}>
      {/* Load failure and not-found are distinct: a transient read error must
          never be reported as a deletion the user did not perform. */}
      {error ? (
        <ErrorState
          title="Couldn't load this dashboard"
          description={error}
          onRetry={() => router.refresh()}
        />
      ) : !dashboard ? (
        <EmptyState
          title="Dashboard not found"
          description="It may have been deleted, or you may not have access to it."
        />
      ) : (
        <>
          {/* The switcher is a page-level navigation control, so it rides in
              `actions` rather than beside the title — inside the title it would
              land in the heading's accessible name, which would have a screen
              reader announce the page as "<name>, Switch". */}
          <PageHeader
            title={dashboard.name}
            caption={dashboard.description}
            actions={
              <>
                <DashboardSelector initialDashboards={initialDashboards} />
                <ScopeSelector />
                <TimeRangeSelector />
                <Tooltip
                  title={
                    dashboard.widgets.length >= MAX_WIDGETS_PER_DASHBOARD
                      ? `Maximum of ${MAX_WIDGETS_PER_DASHBOARD} widgets reached`
                      : ''
                  }
                >
                  {/* A disabled button fires no pointer events, so the tooltip
                      needs a live wrapper to hang its listeners on. */}
                  <span>
                    <Button
                      variant="contained"
                      startIcon={<Iconify icon="eva:plus-fill" />}
                      disabled={dashboard.widgets.length >= MAX_WIDGETS_PER_DASHBOARD}
                      onClick={() => setDialogOpen(true)}
                    >
                      Add Widget
                    </Button>
                  </span>
                </Tooltip>
              </>
            }
          />

          {/* Widget Grid — the header's own bottom margin is the gap above it. */}
          <Box
            sx={{
              '& .react-grid-item': {
                transition: 'all 200ms ease',
              },
              '& .react-grid-item.react-grid-placeholder': {
                bgcolor: 'primary.lighter',
                borderRadius: 2,
                opacity: 0.4,
              },
              '& .react-grid-item > .react-resizable-handle': {
                opacity: 0,
                transition: 'opacity 200ms ease',
              },
              '& .react-grid-item:hover > .react-resizable-handle': {
                opacity: 1,
              },
            }}
          >
            {dashboard.widgets.length === 0 ? (
              <EmptyState
                variant="dashed"
                icon={
                  <Iconify
                    icon="solar:widget-add-line-duotone"
                    width={48}
                    sx={{ color: 'text.secondary' }}
                  />
                }
                title="No widgets yet"
                description="Add your first widget to start visualizing data"
                action={
                  <Button
                    variant="outlined"
                    startIcon={<Iconify icon="eva:plus-fill" />}
                    onClick={() => setDialogOpen(true)}
                  >
                    Add Widget
                  </Button>
                }
              />
            ) : (
              <GridLayout
                layout={rglLayout}
                onLayoutChange={handleLayoutChange}
                width={width}
                gridConfig={{
                  cols: GRID_COLS,
                  rowHeight: ROW_HEIGHT,
                  margin: GRID_MARGIN,
                  containerPadding: [0, 0],
                }}
                autoSize
              >
                {dashboard.widgets.map((widget) => (
                  <div key={widget.id}>
                    <WidgetRenderer widget={widget} onDelete={handleWidgetDelete} />
                  </div>
                ))}
              </GridLayout>
            )}
          </Box>

          {/* Add Widget Dialog */}
          <WidgetConfigDialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            dashboardId={dashboard.id}
            onCreated={handleWidgetCreated}
          />
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Export (wraps in DashboardProvider)
// ---------------------------------------------------------------------------

interface DashboardViewProps {
  dashboardId: string;
  appId: string;
  initialDashboard: Dashboard | null;
  initialDashboards: DashboardSummary[];
  /** The React Server Component (RSC) read's failure message, if it failed. */
  loadError?: string | null;
}

export function DashboardView({ dashboardId, appId, initialDashboard, initialDashboards, loadError = null }: DashboardViewProps) {
  return (
    <DashboardProvider
      dashboardId={dashboardId}
      appId={appId}
      initialDashboard={initialDashboard}
      loadError={loadError}
    >
      <DashboardContent initialDashboards={initialDashboards} />
    </DashboardProvider>
  );
}
