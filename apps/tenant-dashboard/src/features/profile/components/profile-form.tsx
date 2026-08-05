"use client";
import { z } from "zod";
import { useMemo, useCallback, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { useSnackbar } from '@/components/snackbar';
import FormProvider, { RHFUploadAvatar, RHFTextField } from "@/components/hook-form";
import { SettingsSection } from "@/components/settings-shell";
import { useTranslate } from "@outerlayer/locales";
import { useProfile } from "../../../hooks/use-profile";
import { useAuthContext } from "@/lib/adapters/use-auth-context";
import { TextField } from "@mui/material";

// ----------------------------------------------------------------------

const getValidationTranslations = (key: string) => {
  return `auth.validation.${key}`;
};

const getTranslations = (key: string) => {
  return `dashboard.profileSettings.${key}`;
};

export default function ProfileForm() {
  const { enqueueSnackbar } = useSnackbar();
  const { profile, updateProfile } = useProfile();
  const { user, updateEmail } = useAuthContext();

  const currentEmail = (user?.email as string) || "";

  const { t } = useTranslate();
  const UserSchema = z.object({
    name: z
      .string()
      .min(1, t(getValidationTranslations("name.required")))
      .max(100, t(getValidationTranslations("name.max"))),
    email: z
      .string()
      .min(1, t(getValidationTranslations("email.required")))
      .email(t(getValidationTranslations("email.invalid"))),
    avatarUrl: z.any().nullable(),
  });

  const defaultValues = useMemo(
    () => ({
      name: profile?.name || "",
      email: (user?.email as string) || "",
      avatarUrl: profile?.avatar_url || null,
    }),
    [profile, user?.email]
  );

  const methods = useForm({
    resolver: zodResolver(UserSchema),
    defaultValues,
  });

  const {
    setValue,
    handleSubmit,
    formState: { isSubmitting },
  } = methods;


  useEffect(() => {
    setValue("name", profile?.name || "");
    setValue("avatarUrl", profile?.avatar_url || null);
  }, [profile, setValue]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      const emailChanged =
        data.email.toLowerCase() !== currentEmail.toLowerCase();

      // Handle email change via Supabase Auth (double confirmation flow)
      if (emailChanged) {
        const result = await updateEmail(data.email);
        if (!result.success) {
          const errorCode = result.errorCode || "unknown";
          enqueueSnackbar(
            t(getTranslations(`emailChangeErrors.${errorCode}`)),
            { variant: "error" }
          );
          // Revert the email field since the change didn't go through
          setValue("email", currentEmail);
          return;
        }
        enqueueSnackbar(t(getTranslations("emailChangeSuccess")), {
          variant: "success",
          autoHideDuration: 8000,
        });
        // Revert to current email — it won't change until both emails are confirmed
        setValue("email", currentEmail);
      }

      // Update profile (name/avatar)
      await updateProfile({
        name: data.name,
        avatar_url: data.avatarUrl,
      });

      if (!emailChanged) {
        enqueueSnackbar(t(getTranslations("successNotification")));
      }
    } catch (error) {
      enqueueSnackbar((error as Error).message, {
        variant: "error",
      });
    }
  });

  const handleDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0]!;
      const newFile = Object.assign(file, {
        preview: URL.createObjectURL(file),
      });

      if (file) {
        setValue("avatarUrl", newFile, { shouldValidate: true });
      }
    },
    [setValue]
  );

  return (
    <FormProvider methods={methods} onSubmit={onSubmit}>
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
            rowGap: 3,
            width: "100%",
            columnGap: 2,
            display: "grid",
          }}>
          <RHFUploadAvatar
            name="avatarUrl"
            maxSize={3145728}
            onDrop={handleDrop}
            helperText={
              <Typography
                variant="caption"
                sx={{
                  mt: 3,
                  mx: "auto",
                  display: "block",
                  textAlign: "center",
                  color: "text.disabled",
                }}
              >
                {t(getTranslations("allowedImageTypes"))}
                <br /> {t(getTranslations("allowedImageSize"))}
              </Typography>
            }
          />
          <RHFTextField
            name="name"
            label={t(getTranslations("namePlaceholder"))}
          />
          <RHFTextField
            name="email"
            label={t(getTranslations("emailPlaceholder"))}
          />
          <TextField
            disabled
            value={user?.role}
            label={t(getTranslations("rolePlaceholder"))}
          />
        </Box>
      </SettingsSection>
    </FormProvider>
  );
}
