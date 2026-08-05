'use client';

/**
 * Displays dashboards as cards with action menus for rename, duplicate,
 * delete, and set-default. Redirects to default dashboard if one is set.
 */

import { useCallback, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Iconify from '@/components/iconify';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { useSnackbar } from '@/components/snackbar';
import { useDashboards } from '../hooks/use-dashboards';
import { appPaths } from '@/routes/paths';
import { useSelectedEnv } from "@/hooks/environments/use-selected-env";
import { MAX_DASHBOARDS_PER_APP } from '../types';
import type { DashboardSummary, DashboardTemplate } from '../types';
import { TemplateGallery } from './template-gallery';
import { useAppPermissions } from '@/lib/adapters/use-app-permissions';

type DialogState =
  | { type: 'none' }
  | { type: 'create' }
  | { type: 'rename'; dashboard: DashboardSummary }
  | { type: 'delete'; dashboard: DashboardSummary };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DashboardListProps {
  appId: string;
  initialDashboards: DashboardSummary[];
  initialTemplates: DashboardTemplate[];
  /** Set when the React Server Component (RSC)'s list read failed. Read straight through on every
   *  render rather than seeded into state — it is the server's current
   *  answer, so a re-render must be able to both clear a recovered failure
   *  and report a fresh one. */
  loadError?: string | null;
}

export function DashboardList({ appId, initialDashboards, initialTemplates, loadError = null }: DashboardListProps) {
  const router = useRouter();
  const params = useParams<{ orgName: string; appName: string }>();
  const selectedEnv = useSelectedEnv();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = useAppPermissions(appId);
  const canCreateDashboard = hasPermission("dashboard.insert");
  const {
    dashboards,
    createDashboard,
    deleteDashboard,
    renameDashboard,
    duplicateDashboard,
    setDefault,
  } = useDashboards({ appId, initialDashboards });

  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });
  const [inputValue, setInputValue] = useState('');
  const [operating, setOperating] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  // Action menu state
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [menuDashboard, setMenuDashboard] = useState<DashboardSummary | null>(null);

  const closeDialog = useCallback(() => {
    setDialog({ type: 'none' });
    setInputValue('');
    setOperationError(null);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuAnchor(null);
    setMenuDashboard(null);
  }, []);

  // --- Create ---
  const handleCreate = useCallback(async () => {
    if (!inputValue.trim()) return;
    setOperating(true);
    setOperationError(null);
    try {
      const dashboard = await createDashboard({ name: inputValue.trim() });
      closeDialog();
      router.push(appPaths.dashboards.view(params.orgName, params.appName, selectedEnv.name, dashboard.id));
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : 'Failed to create dashboard');
    } finally {
      setOperating(false);
    }
  }, [inputValue, createDashboard, router, params, closeDialog]);

  // --- Rename ---
  const handleRename = useCallback(async () => {
    if (dialog.type !== 'rename' || !inputValue.trim()) return;
    setOperating(true);
    setOperationError(null);
    try {
      await renameDashboard(dialog.dashboard.id, inputValue.trim());
      closeDialog();
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : 'Failed to rename dashboard');
    } finally {
      setOperating(false);
    }
  }, [dialog, inputValue, renameDashboard, closeDialog]);

  // --- Delete ---
  const handleDelete = useCallback(async () => {
    if (dialog.type !== 'delete') return;
    setOperating(true);
    setOperationError(null);
    try {
      await deleteDashboard(dialog.dashboard.id);
      closeDialog();
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : 'Failed to delete dashboard');
    } finally {
      setOperating(false);
    }
  }, [dialog, deleteDashboard, closeDialog]);

  // --- Duplicate ---
  // Menu actions have no dialog to carry `helperText`, so their failures go to
  // a toast. The list cannot report them by itself: `useDashboards` is a
  // fetcher-less cache whose only writer is the mutation that just failed, so
  // a dropped error leaves the grid looking exactly as it did on success.
  const handleDuplicate = useCallback(async (dashboard: DashboardSummary) => {
    try {
      await duplicateDashboard(dashboard.id);
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : 'Failed to duplicate dashboard', {
        variant: 'error',
      });
    }
    closeMenu();
  }, [duplicateDashboard, closeMenu, enqueueSnackbar]);

  // --- Set Default ---
  const handleSetDefault = useCallback(async (dashboard: DashboardSummary) => {
    try {
      await setDefault(dashboard.id);
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : 'Failed to set the default dashboard', {
        variant: 'error',
      });
    }
    closeMenu();
  }, [setDefault, closeMenu, enqueueSnackbar]);

  const navigateToDashboard = useCallback(
    (dashboardId: string) => {
      router.push(appPaths.dashboards.view(params.orgName, params.appName, selectedEnv.name, dashboardId));
    },
    [router, params]
  );

  return (
    // The header sits OUTSIDE the spacing container on purpose: it carries its
    // own bottom margin, and as a child of `Stack spacing` it would collect the
    // parent's gap on top of it — a doubled gap that shows up in a browser and
    // in no diff.
    <Box>
      <PageHeader
        title="Dashboards"
        actions={
          <Tooltip
            title={
              loadError
                ? 'Retry the list before creating a new dashboard'
                : (dashboards?.length ?? 0) >= MAX_DASHBOARDS_PER_APP
                  ? `Maximum of ${MAX_DASHBOARDS_PER_APP} dashboards reached`
                  : ''
            }
          >
            {/* A disabled button fires no pointer events, so the tooltip needs a
                live wrapper to hang its listeners on. */}
            <span>
              {canCreateDashboard && (
                <Button
                  variant="contained"
                  startIcon={<Iconify icon="eva:plus-fill" />}
                  disabled={!!loadError || (dashboards?.length ?? 0) >= MAX_DASHBOARDS_PER_APP}
                  onClick={() => {
                    setInputValue('');
                    setDialog({ type: 'create' });
                  }}
                >
                  New Dashboard
                </Button>
              )}
            </span>
          </Tooltip>
        }
      />
      <Stack spacing={3}>
      {/* Dashboard Grid — a failed read and a genuinely empty list are
          distinct: the cold-start gallery below says "you have none", which is
          a claim only a SUCCESSFUL read can make. */}
      {loadError ? (
        <ErrorState
          title="Couldn't load your dashboards"
          description={loadError}
          onRetry={() => router.refresh()}
        />
      ) : !dashboards || dashboards.length === 0 ? (
        <Stack spacing={4}>
          <EmptyState
            variant="dashed"
            icon={
              <Iconify
                icon="solar:chart-square-line-duotone"
                width={48}
                sx={{ color: 'text.secondary' }}
              />
            }
            title="No dashboards yet"
            description="Create a blank dashboard or start from a template"
            action={
              canCreateDashboard ? (
                <Button
                  variant="outlined"
                  startIcon={<Iconify icon="eva:plus-fill" />}
                  onClick={() => {
                    setInputValue('');
                    setDialog({ type: 'create' });
                  }}
                >
                  Create Empty Dashboard
                </Button>
              ) : undefined
            }
          />

          {canCreateDashboard && <TemplateGallery initialTemplates={initialTemplates} createDashboard={createDashboard} />}
        </Stack>
      ) : (
        <Grid container spacing={3}>
          {dashboards.map((d) => (
            <Grid key={d.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card sx={{ height: '100%' }}>
                <CardContent
                  sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                  onClick={() => navigateToDashboard(d.id)}
                >
                  <Stack spacing={1}>
                    <Stack
                      direction="row"
                      sx={{
                        alignItems: "center",
                        justifyContent: "space-between"
                      }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{
                          alignItems: "center",
                          minWidth: 0
                        }}>
                        <Typography variant="subtitle1" noWrap>
                          {d.name}
                        </Typography>
                        {d.isDefault && (
                          <Iconify icon="eva:star-fill" width={16} sx={{ color: 'warning.main', flexShrink: 0 }} />
                        )}
                      </Stack>
                      <IconButton
                        size="small"
                        aria-label={`Dashboard actions for ${d.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuAnchor(e.currentTarget);
                          setMenuDashboard(d);
                        }}
                      >
                        <Iconify icon="eva:more-vertical-fill" width={18} />
                      </IconButton>
                    </Stack>
                    {d.description && (
                      <Typography variant="body2" noWrap sx={{
                        color: "text.secondary"
                      }}>
                        {d.description}
                      </Typography>
                    )}
                    <Typography variant="caption" sx={{
                      color: "text.disabled"
                    }}>
                      {d.widgetCount} widget{d.widgetCount !== 1 ? 's' : ''}
                    </Typography>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
      {/* Templates — shown below existing dashboards too. Gated on
          dashboard.insert: the gallery only offers create-from-template
          actions, so a user who cannot create dashboards must not see it. */}
      {canCreateDashboard && dashboards && dashboards.length > 0 && <TemplateGallery initialTemplates={initialTemplates} createDashboard={createDashboard} />}
      {/* Action Menu */}
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem onClick={() => {
          if (menuDashboard) {
            setInputValue(menuDashboard.name);
            setDialog({ type: 'rename', dashboard: menuDashboard });
          }
          closeMenu();
        }}>
          <ListItemIcon><Iconify icon="eva:edit-2-outline" width={20} /></ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>

        <MenuItem onClick={() => {
          if (menuDashboard) handleDuplicate(menuDashboard);
        }}>
          <ListItemIcon><Iconify icon="eva:copy-outline" width={20} /></ListItemIcon>
          <ListItemText>Duplicate</ListItemText>
        </MenuItem>

        {menuDashboard && !menuDashboard.isDefault && (
          <MenuItem onClick={() => {
            if (menuDashboard) handleSetDefault(menuDashboard);
          }}>
            <ListItemIcon><Iconify icon="eva:star-outline" width={20} /></ListItemIcon>
            <ListItemText>Set as Default</ListItemText>
          </MenuItem>
        )}

        <MenuItem
          onClick={() => {
            if (menuDashboard) {
              setDialog({ type: 'delete', dashboard: menuDashboard });
            }
            closeMenu();
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon><Iconify icon="eva:trash-2-outline" width={20} sx={{ color: 'error.main' }} /></ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>
      {/* Create Dialog */}
      <Dialog
        open={dialog.type === 'create'}
        onClose={closeDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New Dashboard</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            error={!!operationError}
            helperText={operationError}
            sx={{ mt: 1 }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={operating}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            loading={operating}
            disabled={operating || !inputValue.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
      {/* Rename Dialog */}
      <Dialog
        open={dialog.type === 'rename'}
        onClose={closeDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Rename Dashboard</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            error={!!operationError}
            helperText={operationError}
            sx={{ mt: 1 }}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={operating}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleRename}
            loading={operating}
            disabled={operating || !inputValue.trim()}
          >
            Rename
          </Button>
        </DialogActions>
      </Dialog>
      {/* Delete Confirmation Dialog */}
      <Dialog
        open={dialog.type === 'delete'}
        onClose={closeDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete Dashboard</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete &quot;{dialog.type === 'delete' ? dialog.dashboard.name : ''}&quot;?
            This action cannot be undone. All widgets in this dashboard will be permanently removed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={operating}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDelete}
            loading={operating}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
      </Stack>
    </Box>
  );
}
