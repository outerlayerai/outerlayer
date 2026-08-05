"use client";

import { m } from "framer-motion";

import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import CompactLayout from "../../layouts/compact";
import { StaggerContainer, settleIn } from "./motion";
import { RouterLink } from "../../routes/components";
import IconTile from "../../components/icon-tile";
import { useTranslate } from "@outerlayer/locales";

export default function ForbiddenView() {
  const { t } = useTranslate();
  return (
    <CompactLayout>
      <StaggerContainer>
        <m.div variants={settleIn}>
          <Typography variant="h3" sx={{ mb: 2 }}>
            {t("systemPages.forbidden.title")}
          </Typography>
        </m.div>

        <m.div variants={settleIn}>
          <Typography sx={{ color: "text.secondary" }}>
            {t("systemPages.forbidden.description")}
          </Typography>
        </m.div>

        <m.div variants={settleIn}>
          <IconTile
            icon="mdi:shield-lock-outline"
            size={120}
            sx={{ my: { xs: 5, sm: 10 } }}
          />
        </m.div>

        <Button
          component={RouterLink}
          href="/"
          size="large"
          variant="contained"
        >
          {t("systemPages.forbidden.returnHomeButton")}
        </Button>
      </StaggerContainer>
    </CompactLayout>
  );
}
