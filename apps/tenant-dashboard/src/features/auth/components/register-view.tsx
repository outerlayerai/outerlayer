"use client";

import { buildRegisterSchema } from "../schemas";
import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import Link from "@mui/material/Link";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import InputAdornment from "@mui/material/InputAdornment";

import { paths } from "@/routes/paths";
import { RouterLink } from "@/routes/components";

import { useBoolean } from "@/hooks/use-boolean";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { TermsCheckbox } from "@/components/terms-checkbox";
import { useTranslate } from "@outerlayer/locales";
import { ServerActionResponse } from "@/types/server-action";
import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

type Props = {
  registerWithGithub: (returnTo?: string | null) => Promise<void>;
  finalizeRegistration: (
    email: string,
    password: string,
    firstName: string,
    lastName: string,
    redirectUrl: string
  ) => Promise<ServerActionResponse<{ userId: string }> | void>;
  registerWithGoogle: (returnTo?: string | null) => Promise<void>;
  /**
   * Sanitized post-registration destination (e.g. the invite accept page
   * `/auth/accept-invite?id=…` an unauthenticated user landed on). Threaded
   * through email verification (`emailRedirectTo`) and the OAuth callback
   * chain so the user resumes the original flow once the account exists.
   * When null, the existing `/orgs` default applies.
   */
  returnTo?: string | null;
};

export default function SupabaseRegisterView({ finalizeRegistration, registerWithGithub, registerWithGoogle, returnTo }: Props) {
  const { t } = useTranslate();

  const [errorMsg, setErrorMsg] = useState("");

  const password = useBoolean();

  // Skip-company-setup: companyName removed from registration form
  // Users create organizations later via /orgs page
  const RegisterSchema = buildRegisterSchema(t);

  const defaultValues = {
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    agreedToTerms: false,
  };

  const methods = useForm({
    resolver: zodResolver(RegisterSchema),
    defaultValues,
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = methods;
  const onSubmit = handleSubmit(async (data) => {
    try {
      // Post-registration destination: the `return_to` the user arrived
      // with (invite accept page, deep link), falling back to /orgs.
      // Becomes `emailRedirectTo`, so the confirmation email's link
      // deposits the user there via /auth/confirm.
      const result = await finalizeRegistration(
        data.email,
        data.password,
        data.firstName,
        data.lastName,
        `${window.location.origin}${returnTo ?? paths.orgs.root}`
      );
      if (result && result.error) {
        throw new Error(result.error);
      }
    } catch (error: any) {
      // Next.js redirect() throws a special error — let it propagate
      if (error?.digest?.startsWith("NEXT_REDIRECT")) {
        throw error;
      }
      console.error(error);
      setErrorMsg(typeof error === "string" ? error : error.message);
    }
  });

  const renderHead = (
    <Stack spacing={2} sx={{ mb: 5, position: "relative" }}>
      <Typography variant="h4">{t("auth.register.heading")}</Typography>

      <Stack direction="row" spacing={0.5}>
        <Typography variant="body2">{t("auth.register.subtitle")}</Typography>

        <Link
          // Keep `return_to` when hopping to login so a user who already
          // has an account still resumes the original flow (invite accept
          // page, deep link) after signing in.
          href={
            returnTo
              ? `${paths.auth.login}?return_to=${encodeURIComponent(returnTo)}`
              : paths.auth.login
          }
          component={RouterLink}
          variant="subtitle2"
        >
          {t("auth.register.signInLink")}
        </Link>
      </Stack>
    </Stack>
  );


  const renderForm = (
    <Stack spacing={2.5}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <RHFTextField
          name="firstName"
          label={t("auth.register.firstNamePlaceholder")}
        />
        <RHFTextField
          name="lastName"
          label={t("auth.register.lastNamePlaceholder")}
        />
      </Stack>
      <RHFTextField name="email" label={t("auth.register.emailPlaceholder")} />

      <RHFTextField
        name="password"
        label={t("auth.register.passwordPlaceholder")}
        type={password.value ? "text" : "password"}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton onClick={password.onToggle} edge="end">
                  <Iconify
                    icon={
                      password.value ? "solar:eye-bold" : "solar:eye-closed-bold"
                    }
                  />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />

      <TermsCheckbox />

      <Button
        fullWidth
        color="inherit"
        size="large"
        type="submit"
        variant="contained"
        loading={isSubmitting}
      >
        {t("auth.register.createButton")}
      </Button>
    </Stack>
  );

  const renderOAuth = (
    <>
      <Stack
        spacing={2}
        sx={{
          mt: 2,
          justifyContent: "center",
          alignItems: "center",
          color: "text.secondary"
        }}>
        <Typography variant="body2">{t("auth.register.or")}</Typography>
        <Button
          fullWidth
          variant="outlined"
          onClick={() => registerWithGoogle(returnTo)}
          size="large"
          startIcon={<Iconify icon="mdi:google" />}
        >
          {t("auth.register.registerWithGoogle")}
        </Button>
        <Button
          fullWidth
          variant="outlined"
          onClick={() => registerWithGithub(returnTo)}
          size="large"
          startIcon={<Iconify icon="mdi:github" />}
        >
          {t("auth.register.registerWithGitHub")}
        </Button>
      </Stack>
    </>
  );

  return (
    <>
      {renderHead}

      {!!errorMsg && (
        <Alert severity="error" sx={{ mb: 3 }} data-testid="register-error-alert">
          {errorMsg}
        </Alert>
      )}


      <FormProvider methods={methods} onSubmit={onSubmit}>
        {renderForm}
      </FormProvider>
      {renderOAuth}
    </>
  );
}
