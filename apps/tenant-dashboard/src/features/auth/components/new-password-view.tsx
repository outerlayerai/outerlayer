"use client";

import { buildNewPasswordSchema } from "../schemas";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";

import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import InputAdornment from "@mui/material/InputAdornment";

import { paths } from "@/routes/paths";
import { useRouter } from "@/routes/hooks";

import { useBoolean } from "@/hooks/use-boolean";

import { useAuthContext } from "@/lib/adapters/use-auth-context";
import IconTile from "@/components/icon-tile";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { useTranslate } from "@outerlayer/locales";
import { useMounted } from "@/hooks/use-mounted";
import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

export default function SupabaseNewPasswordView() {
  const router = useRouter();
  const { t } = useTranslate();

  const [errorMsg, setErrorMsg] = useState("");

  const { updatePassword, user } = useAuthContext();

  // Invited users arrive here straight from the invite email having never
  // had a password, so the reset-flow copy ("Update to use your new
  // password") reads as an error to them. flow=invite switches to
  // first-time-setup copy; company_name is stamped into user_metadata when
  // the admin generates the invite.
  const searchParams = useSearchParams();
  const isInviteFlow = searchParams.get("flow") === "invite";
  const companyName = user?.user_metadata?.company_name;

  const password = useBoolean();

  const { isMounted } = useMounted();

  const NewPasswordSchema = buildNewPasswordSchema(t);

  const defaultValues = {
    password: "",
    confirmPassword: "",
  };

  const methods = useForm({
    mode: "onChange",
    resolver: zodResolver(NewPasswordSchema),
    defaultValues,
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = methods;

  const onSubmit = handleSubmit(async (data) => {
    try {
      await updatePassword?.(data.password);

      router.push(paths.dashboard.root);
    } catch (error: any) {
      console.error(error);
      // No session means the email link that brought the user here never
      // established one (expired or already used) — no password they type
      // can ever succeed. Send them to the explanation page instead of
      // surfacing GoTrue's raw "Auth session missing!" on a dead-end form.
      if (error?.name === "AuthSessionMissingError") {
        router.replace(paths.auth.linkExpired);
        return;
      }
      setErrorMsg(typeof error === "string" ? error : error.message);
    }
  });

  const renderHead = (
    <>
      <IconTile icon="mdi:key-outline" />

      <Stack spacing={1} sx={{ mt: 3, mb: 5 }}>
        <Typography variant="h3">
          {!isInviteFlow
            ? t("auth.newPassword.title")
            : companyName
              ? t("auth.newPassword.inviteTitleWithCompany", { company: companyName })
              : t("auth.newPassword.inviteTitle")}
        </Typography>

        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {isInviteFlow
            ? t("auth.newPassword.inviteDescription")
            : t("auth.newPassword.description")}
        </Typography>
      </Stack>
    </>
  );

  const renderForm = (
    <Stack spacing={3}>
      <RHFTextField
        name="password"
        label={t("auth.newPassword.passwordPlaceholder")}
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

      <RHFTextField
        name="confirmPassword"
        label={t("auth.newPassword.confirmPlaceholder")}
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

      <Button
        fullWidth
        type="submit"
        size="large"
        variant="contained"
        loading={isSubmitting}
      >
        {isInviteFlow
          ? t("auth.newPassword.setPasswordButton")
          : t("auth.newPassword.updateButton")}
      </Button>
    </Stack>
  );

  return (
    isMounted && (
      <>
        {renderHead}

        {!!errorMsg && (
          <Alert severity="error" sx={{ textAlign: "left", mb: 3 }}>
            {errorMsg}
          </Alert>
        )}

        <FormProvider methods={methods} onSubmit={onSubmit}>
          {renderForm}
        </FormProvider>
      </>
    )
  );
}
