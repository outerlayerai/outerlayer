"use client";

import { buildForgotPasswordSchema } from "../schemas";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";

import { paths } from "@/routes/paths";
import { useRouter } from "@/routes/hooks";
import { RouterLink } from "@/routes/components";

import { useAuthContext } from "@/lib/adapters/use-auth-context";
import IconTile from "@/components/icon-tile";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

export default function SupabaseForgotPasswordView() {
  const { forgotPassword } = useAuthContext();
  const { t } = useTranslate();

  const router = useRouter();

  const ForgotPasswordSchema = buildForgotPasswordSchema(t);

  const defaultValues = {
    email: "",
  };

  const methods = useForm({
    resolver: zodResolver(ForgotPasswordSchema),
    defaultValues,
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = methods;

  const onSubmit = handleSubmit(async (data) => {
    try {
      await forgotPassword?.(data.email);

      const searchParams = new URLSearchParams({
        email: data.email,
      }).toString();

      const href = `${paths.auth.verify}?${searchParams}`;

      router.push(href);
    } catch (error) {
      console.error(error);
    }
  });

  const renderForm = (
    <Stack spacing={3} sx={{
      alignItems: "center"
    }}>
      <RHFTextField
        name="email"
        label={t("auth.forgotPassword.emailPlaceholder")}
      />

      <Button
        fullWidth
        size="large"
        type="submit"
        variant="contained"
        loading={isSubmitting}
      >
        {t("auth.forgotPassword.sendButton")}
      </Button>

      <Link
        component={RouterLink}
        href={paths.auth.login}
        color="inherit"
        variant="subtitle2"
        sx={{
          alignItems: "center",
          display: "inline-flex",
        }}
      >
        <Iconify icon="eva:arrow-ios-back-fill" width={16} />
        {t("auth.forgotPassword.returnButton")}
      </Link>
    </Stack>
  );

  const renderHead = (
    <>
      <IconTile icon="mdi:lock-outline" />

      <Stack spacing={1} sx={{ mt: 3, mb: 5 }}>
        <Typography variant="h3">{t("auth.forgotPassword.title")}</Typography>

        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("auth.forgotPassword.description")}
        </Typography>
      </Stack>
    </>
  );

  return (
    <>
      {renderHead}

      <FormProvider methods={methods} onSubmit={onSubmit}>
        {renderForm}
      </FormProvider>
    </>
  );
}
