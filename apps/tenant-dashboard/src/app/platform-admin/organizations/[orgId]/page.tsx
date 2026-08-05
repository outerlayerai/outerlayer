import { notFound } from 'next/navigation';
import { Container } from '@mui/material';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { OrgDetail } from '../../../../sections/platform-admin/organizations/org-detail';
import { getOrganizationDetail } from '../../../../sections/platform-admin/organizations/actions';
import { paths } from '../../../../routes/paths';

export const metadata = {
  title: 'Organization Details | Platform Admin',
};

interface OrganizationDetailPageProps {
  params: Promise<{ orgId: string }>;
}

export default async function OrganizationDetailPage({
  params,
}: OrganizationDetailPageProps) {
  const { orgId } = await params;
  const result = await getOrganizationDetail(orgId);

  if (result.error || !result.data) {
    notFound();
  }

  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading={result.data.organization_name}
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Organizations', href: paths.platformAdmin.organizations },
          { name: result.data.organization_name },
        ]}
        sx={{ mb: 3 }}
      />
      <OrgDetail organization={result.data} />
    </Container>
  );
}
