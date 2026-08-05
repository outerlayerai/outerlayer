'use client';

import { useEffect, useState } from 'react';
import { m } from 'framer-motion';

import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import IconTile from '../../components/icon-tile';
import { StaggerContainer, settleIn } from './motion';
import CompactLayout from '../../layouts/compact';
import { RouterLink } from '../../routes/components';
import { useTranslate } from "@outerlayer/locales";

// ----------------------------------------------------------------------

export default function NotFoundView() {
  const { t } = useTranslate();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Skip SSR — useTranslate resolves locale differently on server vs client
  // and triggers React #418 hydration errors on the auth-code-error 404 path.
  if (!mounted) {
    return null;
  }

  return (
    <CompactLayout>
      <StaggerContainer>
        <m.div variants={settleIn}>
          <Typography variant="h3" sx={{ mb: 2 }}>
            {t("systemPages.notFound.title")}
          </Typography>
        </m.div>

        <m.div variants={settleIn}>
          <Typography sx={{ color: 'text.secondary' }}>
            {t("systemPages.notFound.description")}
          </Typography>
        </m.div>

        <m.div variants={settleIn}>
          <IconTile
            icon="eva:question-mark-circle-outline"
            size={120}
            sx={{ my: { xs: 5, sm: 10 } }}
          />
        </m.div>

        <Button component={RouterLink} href="/" size="large" variant="contained">
          {t("systemPages.notFound.returnHomeButton")}
        </Button>
      </StaggerContainer>
    </CompactLayout>
  );
}
