import { Container } from '@mui/material';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { ActiveGrants } from '../../../sections/platform-admin/temp-access/active-grants';
import { listActiveGrants } from '../../../sections/platform-admin/temp-access/actions';
import { paths } from '../../../routes/paths';

export const metadata = {
  title: 'Temporary Access | Platform Admin',
};

export default async function TempAccessPage() {
  // Fetch initial data server-side for better performance
  const result = await listActiveGrants();

  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading="Temporary Access Grants"
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Temporary Access' },
        ]}
        sx={{ mb: 3 }}
      />
      <ActiveGrants initialGrants={result.data || undefined} />
    </Container>
  );
}
