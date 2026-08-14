"use client";

import { Alert, Card, Stack, Typography } from "@mui/material";
import { useTranslate } from "@outerlayer/locales";

type Props = {
  variant: "missingAuthorization" | "error";
};

export const OAuthConsentErrorCard = ({ variant }: Props) => {
  const { t } = useTranslate();
  const title =
    variant === "missingAuthorization"
      ? t("auth.oauthConsent.errors.missingAuthorizationTitle")
      : t("auth.oauthConsent.errors.errorTitle");
  const description =
    variant === "missingAuthorization"
      ? t("auth.oauthConsent.errors.missingAuthorizationDescription")
      : t("auth.oauthConsent.errors.errorDescription");
  return (
    <Card sx={{ p: 4, maxWidth: 480, mx: "auto", mt: 8 }}>
      <Stack spacing={2}>
        <Typography variant="h5">{title}</Typography>
        <Alert severity="error">{description}</Alert>
      </Stack>
    </Card>
  );
};
