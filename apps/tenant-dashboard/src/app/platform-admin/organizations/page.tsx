import { Container } from '@mui/material';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { OrgList } from '../../../sections/platform-admin/organizations/org-list';
import { listOrganizations } from '../../../sections/platform-admin/organizations/actions';
import { paths } from '../../../routes/paths';

export const metadata = {
  title: 'Organizations | Platform Admin',
};

export default async function OrganizationsPage() {
  // Fetch initial data server-side for better performance
  const result = await listOrganizations({
    page: 1,
    pageSize: 25,
    sortBy: 'created_at',
    sortOrder: 'desc',
  });

  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading="Organizations"
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Organizations' },
        ]}
        sx={{ mb: 3 }}
      />
      <OrgList initialData={result.data || undefined} />
    </Container>
  );
}
