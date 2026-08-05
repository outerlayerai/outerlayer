'use client';

import { useState } from 'react';
import { Container, Button } from '@mui/material';
import Iconify from '@/components/iconify';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { paths } from '../../../routes/paths';
import { FlagList } from '../../../sections/platform-admin/feature-flags/flag-list';
import { FlagEditor } from '../../../sections/platform-admin/feature-flags/flag-editor';
import { CreateFlagModal } from '../../../sections/platform-admin/feature-flags/create-flag-modal';

export default function FeatureFlagsPage() {
  const [selectedFlagId, setSelectedFlagId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSelectFlag = (flagId: string) => {
    setSelectedFlagId(flagId);
  };

  const handleCloseEditor = () => {
    setSelectedFlagId(null);
  };

  const handleUpdate = () => {
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <Container maxWidth="lg">
      <CustomBreadcrumbs
        heading="Feature Flags"
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Feature Flags' },
        ]}
        action={
          <Button
            variant="contained"
            startIcon={<Iconify icon="mdi:flag-plus" />}
            onClick={() => setCreateModalOpen(true)}
          >
            Create Flag
          </Button>
        }
        sx={{ mb: 3 }}
      />

      <FlagList key={refreshKey} onSelectFlag={handleSelectFlag} />

      <FlagEditor
        flagId={selectedFlagId}
        open={!!selectedFlagId}
        onClose={handleCloseEditor}
        onUpdate={handleUpdate}
      />

      <CreateFlagModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSuccess={handleUpdate}
      />
    </Container>
  );
}
