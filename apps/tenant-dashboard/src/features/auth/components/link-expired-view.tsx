"use client";

import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

import { paths } from "@/routes/paths";
import { RouterLink } from "@/routes/components";

import IconTile from "@/components/icon-tile";

import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

export default function LinkExpiredView() {
  const { t } = useTranslate();

  return (
    <>
      <IconTile icon="mdi:email-outline" />

      <Stack spacing={1} sx={{ mt: 3, mb: 5 }}>
        <Typography variant="h3">{t("auth.linkExpired.title")}</Typography>

        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("auth.linkExpired.description")}
        </Typography>
      </Stack>

      <Stack spacing={3}>
        <Button
          fullWidth
          size="large"
          variant="contained"
          component={RouterLink}
          href={paths.auth.forgotPassword}
        >
          {t("auth.linkExpired.requestNewLink")}
        </Button>

        <Link
          component={RouterLink}
          href={paths.auth.login}
          color="inherit"
          variant="subtitle2"
          sx={{
            alignItems: "center",
            display: "inline-flex",
            justifyContent: "center",
          }}
        >
          <Iconify icon="eva:arrow-ios-back-fill" width={16} />
          {t("auth.linkExpired.returnToSignIn")}
        </Link>
      </Stack>
    </>
  );
}
