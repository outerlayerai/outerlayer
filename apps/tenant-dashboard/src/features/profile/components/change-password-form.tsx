"use client";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useSnackbar } from '@/components/snackbar';
import FormProvider, { RHFTextField } from "@/components/hook-form";
import { SettingsSection } from "@/components/settings-shell";
import { useTranslate } from "@outerlayer/locales";
import { createSupabaseFontendClient } from "@/lib/adapters/supabase-frontend-client";

// ----------------------------------------------------------------------

const getTranslations = (key: string) => {
  return `dashboard.profileSettings.${key}`;
};

const getValidationTranslations = (key: string) => {
  return `auth.validation.${key}`;
};

export default function ChangePasswordForm() {
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslate();


  const supabase = createSupabaseFontendClient()

  const UserSchema = z
    .object({
      currentPassword: z
        .string()
        .min(1, t(getValidationTranslations("currentPassword.required"))),
      password: z
        .string()
        .min(1, t(getValidationTranslations("password.required")))
        .max(30, t(getValidationTranslations("password.max")))
        .min(6, t(getValidationTranslations("password.min"))),
      confirmPassword: z.string().optional(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t(getValidationTranslations("password.match")),
      path: ["confirmPassword"],
    });

  const defaultValues = {
    currentPassword: "",
    password: "",
    confirmPassword: "",
  };

  const methods = useForm({
    resolver: zodResolver(UserSchema),
    defaultValues,
  });

  const {
    reset,
    handleSubmit,
    formState: { isSubmitting },
  } = methods;

  const onSubmit = handleSubmit(async (data) => {
    try {
      const {error}= await supabase.rpc("change_user_password", {
        current_plain_password: data.currentPassword,
        new_plain_password: data.password,
      })

      if(error){
        throw error
      }
      reset();
      enqueueSnackbar(t(getTranslations("successNotification")));
    } catch (error) {
      enqueueSnackbar((error as Error).message, {
        variant: "error",
      });
    }
  });

  const renderForm = (
    <SettingsSection
      footer={{
        action: (
          <Button type="submit" variant="contained" loading={isSubmitting}>
            {t(getTranslations("saveButton"))}
          </Button>
        ),
      }}
    >
      <Box
        sx={{
          width: "100%",
          rowGap: 3,
          columnGap: 2,
          display: "grid",
        }}>
        <RHFTextField
          name="currentPassword"
          type="password"
          label={t(getTranslations("currentPasswordPlaceholder"))}
        />
        <RHFTextField
          name="password"
          type="password"
          label={t(getTranslations("passwordPlaceholder"))}
        />
        <RHFTextField
          name="confirmPassword"
          type="password"
          label={t(getTranslations("confirmPasswordPlaceholder"))}
        />
      </Box>
    </SettingsSection>
  );

  return (
    <FormProvider methods={methods} onSubmit={onSubmit}>
      {renderForm}
    </FormProvider>
  );
}
