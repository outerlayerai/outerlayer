'use client';

import { useState } from 'react';
import { Container } from '@mui/material';
import CustomBreadcrumbs from '@/components/custom-breadcrumbs';
import { AuditLogList } from '../../../sections/platform-admin/audit-logs/audit-log-list';
import { AuditLogDetail } from '../../../sections/platform-admin/audit-logs/audit-log-detail';
import { paths } from '../../../routes/paths';

export default function AuditLogsPage() {
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const handleViewDetail = (logId: string) => {
    setSelectedLogId(logId);
    setDetailOpen(true);
  };

  const handleCloseDetail = () => {
    setDetailOpen(false);
    setSelectedLogId(null);
  };

  return (
    <Container maxWidth="xl">
      <CustomBreadcrumbs
        heading="Audit Logs"
        links={[
          { name: 'Platform Admin', href: paths.platformAdmin.root },
          { name: 'Audit Logs' },
        ]}
        sx={{ mb: 3 }}
      />

      <AuditLogList onViewDetail={handleViewDetail} />

      <AuditLogDetail
        logId={selectedLogId}
        open={detailOpen}
        onClose={handleCloseDetail}
      />
    </Container>
  );
}
