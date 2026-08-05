'use client';

import { Container } from '@mui/material';

import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { paths } from '@/routes/paths';
import { DoraMetricsView } from '@/sections/dora-metrics/dora-metrics-view';

export default function DoraMetricsPage() {
  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading="DORA Metrics"
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'DORA Metrics' },
        ]}
        sx={{ mb: 3 }}
      />

      <DoraMetricsView />
    </Container>
  );
}
