"use client";

import { Alert } from "@mui/material";
import { useTranslate } from "@outerlayer/locales";

export const OAuthGrantsError = () => {
  const { t } = useTranslate();
  return <Alert severity="warning">{t("dashboard.developers.grants.loadError")}</Alert>;
};
