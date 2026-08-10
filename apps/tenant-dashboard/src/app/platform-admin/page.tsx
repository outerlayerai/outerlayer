'use client';

import { Container, Grid, Card, CardContent, Stack, Typography } from '@mui/material';
import Link from 'next/link';
import Iconify from '@/components/iconify';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { paths } from '../../routes/paths';

const NAV_ITEMS = [
  {
    title: 'Organizations',
    description: 'Browse and manage all organizations',
    icon: 'mdi:office-building',
    href: paths.platformAdmin.organizations,
  },
  {
    title: 'Users',
    description: 'Browse and manage all users',
    icon: 'mdi:account-group',
    href: paths.platformAdmin.users,
  },
  {
    title: 'Feature Flags',
    description: 'Manage feature flags and rollouts',
    icon: 'mdi:flag',
    href: paths.platformAdmin.featureFlags,
  },
  {
    title: 'Temporary Access',
    description: 'View active temporary access grants',
    icon: 'mdi:shield-key',
    href: paths.platformAdmin.tempAccess,
  },
  {
    title: 'Audit Logs',
    description: 'View administrative action history',
    icon: 'mdi:history',
    href: paths.platformAdmin.auditLogs,
  },
];

export default function PlatformAdminPage() {
  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading="Platform Admin Dashboard"
        links={[{ name: 'Platform Admin' }]}
        sx={{ mb: 3 }}
      />
      <Grid container spacing={3}>
        {NAV_ITEMS.map((item) => (
          <Grid size={{ xs: 12, sm: 6, md: 4 }} key={item.title}>
            <Link href={item.href} style={{ textDecoration: 'none' }}>
              <Card sx={{ height: '100%', '&:hover': { boxShadow: 4 } }}>
                <CardContent>
                  <Stack spacing={2}>
                    <Stack direction="row" spacing={2} sx={{
                      alignItems: "center"
                    }}>
                      <Iconify icon={item.icon} width={32} />
                      <Typography variant="h6">{item.title}</Typography>
                    </Stack>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      {item.description}
                    </Typography>
                  </Stack>
                </CardContent>
              </Card>
            </Link>
          </Grid>
        ))}
      </Grid>
    </Container>
  );
}
