"use client";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

import { paths } from "@/routes/paths";
import { useSearchParams } from "next/navigation";
import { RouterLink } from "@/routes/components";

import IconTile from "@/components/icon-tile";

import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

export default function SupabaseVerifyView() {
  const searchParams = useSearchParams();
  const { t } = useTranslate();

  const email = searchParams.get("email");

  const renderHead = (
    <>
      <IconTile icon="mdi:email-outline" sx={{ mb: 5 }} />

      <Typography variant="h3" sx={{ mb: 1 }}>
        Please check your email!
      </Typography>

      <Stack
        spacing={1}
        sx={{ color: "text.secondary", typography: "body2", mb: 5 }}
      >
        <Box component="span"> We have sent a confirmation link to</Box>
        <Box component="strong" sx={{ color: "text.primary" }}>
          {email}
        </Box>
        <Box component="div">Please check your inbox/spam.</Box>
      </Stack>
    </>
  );

  return (
    <>
      {renderHead}

      <Button
        component={RouterLink}
        href={paths.auth.login}
        size="large"
        color="inherit"
        variant="contained"
        startIcon={<Iconify icon="eva:arrow-ios-back-fill" />}
        sx={{ alignSelf: "center" }}
      >
        {t("auth.verify.returnButton")}
      </Button>
    </>
  );
}
