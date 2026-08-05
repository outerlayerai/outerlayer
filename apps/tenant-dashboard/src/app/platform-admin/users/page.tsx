import { Container } from '@mui/material';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { UserList } from '../../../sections/platform-admin/users/user-list';
import { listUsers } from '../../../sections/platform-admin/users/actions';
import { paths } from '../../../routes/paths';

export const metadata = {
  title: 'Users | Platform Admin',
};

export default async function UsersPage() {
  // Fetch initial data server-side for better performance
  const result = await listUsers({
    page: 1,
    pageSize: 25,
    sortBy: 'created_at',
    sortOrder: 'desc',
  });

  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading="Users"
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Users' },
        ]}
        sx={{ mb: 3 }}
      />
      <UserList initialData={result.data || undefined} />
    </Container>
  );
}
