'use client';

/**
 * Displays pre-built dashboard templates as cards with one-click creation.
 */

import { useCallback, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Iconify from '@/components/iconify';
import { useSnackbar } from '@/components/snackbar';
import { appPaths } from '@/routes/paths';
import { useSelectedEnv } from "@/hooks/environments/use-selected-env";
import type { Dashboard, DashboardTemplate } from '../types';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TemplateGalleryProps {
  /** The static template catalog, resolved in a React Server Component (RSC)
   *  — no GET route backs it; it never changes for the life of the page. */
  initialTemplates: DashboardTemplate[];
  /**
   * The list page's OWN `useDashboards().createDashboard` — never a second,
   * independent hook instance. `dashboards` (`use-dashboards.ts`) closes over
   * its own hook's local view of the SWR cache; a second `useDashboards()`
   * call here could run its `createDashboard` before that instance's `data`
   * converges to the list's real cache entry, overwriting the shared cache
   * with just the new row instead of appending to it. Taking the list page's
   * already-converged function as a prop keeps this component's create call
   * on the one instance whose cache view is authoritative.
   */
  createDashboard: (body: { name: string; description?: string; templateId?: string }) => Promise<Dashboard>;
}

export function TemplateGallery({ initialTemplates, createDashboard }: TemplateGalleryProps) {
  const router = useRouter();
  const params = useParams<{ orgName: string; appName: string }>();
  const selectedEnv = useSelectedEnv();
  const { enqueueSnackbar } = useSnackbar();

  const [creating, setCreating] = useState<string | null>(null);

  const handleUseTemplate = useCallback(
    async (template: DashboardTemplate) => {
      setCreating(template.id);
      try {
        const dashboard = await createDashboard({ name: template.name, templateId: template.id });
        router.push(appPaths.dashboards.view(params.orgName, params.appName, selectedEnv.name, dashboard.id));
      } catch (err) {
        // The card looks identical whether the create succeeded or failed —
        // nothing on this surface reflects the new dashboard — so a dropped
        // error reads as a create that silently undid itself.
        enqueueSnackbar(err instanceof Error ? err.message : 'Failed to create dashboard from template', {
          variant: 'error',
        });
      } finally {
        setCreating(null);
      }
    },
    [createDashboard, router, params, selectedEnv.name, enqueueSnackbar]
  );

  const templates = initialTemplates;

  if (templates.length === 0) return null;

  return (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{
        color: "text.secondary"
      }}>
        Start from a Template
      </Typography>
      <Grid container spacing={3}>
        {templates.map((template) => (
          <Grid key={template.id} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ flexGrow: 1 }}>
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} sx={{
                    alignItems: "center"
                  }}>
                    <Iconify icon="solar:chart-square-line-duotone" width={24} />
                    <Typography variant="subtitle1">{template.name}</Typography>
                  </Stack>

                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {template.description}
                  </Typography>

                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {template.widgets.slice(0, 4).map((w, idx) => (
                      <Chip
                        key={idx}
                        label={w.title}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: '0.7rem' }}
                      />
                    ))}
                    {template.widgets.length > 4 && (
                      <Chip
                        label={`+${template.widgets.length - 4} more`}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: '0.7rem' }}
                      />
                    )}
                  </Box>
                </Stack>
              </CardContent>

              <Box sx={{ px: 2, pb: 2 }}>
                <Button
                  fullWidth
                  variant="outlined"
                  size="small"
                  startIcon={<Iconify icon="eva:plus-fill" />}
                  loading={creating === template.id}
                  onClick={() => handleUseTemplate(template)}
                  disabled={!!creating}
                >
                  Use Template
                </Button>
              </Box>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Stack>
  );
}
