import { notFound } from 'next/navigation';
import { Container } from '@mui/material';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { UserDetailView } from '../../../../sections/platform-admin/users/user-detail';
import { getUserDetail } from '../../../../sections/platform-admin/users/actions';
import { paths } from '../../../../routes/paths';

export const metadata = {
  title: 'User Details | Platform Admin',
};

interface UserDetailPageProps {
  params: Promise<{ userId: string }>;
}

export default async function UserDetailPage({ params }: UserDetailPageProps) {
  const { userId } = await params;
  const result = await getUserDetail(userId);

  if (result.error || !result.data) {
    notFound();
  }

  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading={result.data.name || result.data.email}
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Users', href: paths.platformAdmin.users },
          { name: result.data.name || result.data.email },
        ]}
        sx={{ mb: 3 }}
      />
      <UserDetailView user={result.data} />
    </Container>
  );
}
