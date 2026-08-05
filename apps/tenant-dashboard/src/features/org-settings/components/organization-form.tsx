"use client";

import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslate } from "@outerlayer/locales";
import { useSnackbar } from "notistack";
import Button from "@mui/material/Button";
import { Stack } from "@mui/system";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { SettingsSection } from "@/components/settings-shell";

import { updateOrganizationAction } from "../actions";
import type { OrgSettings } from "../types";

type Props = {
  /** Org row seeded by a React Server Component (RSC); null when the read was
   *  denied or the tenant has none. */
  org: OrgSettings | null;
};

const FormSchema = z.object({
  companyName: z.string().min(1, "Company name is required"),
  // Read-only display field, not part of the write payload — excluded from
  // updateOrganizationAction's input by zod's default strip-unknown-keys.
  tenantId: z.string().optional(),
});

/**
 * The org-general form: RSC-seeded, no client-side Supabase fetch. The write
 * goes through `updateOrganizationAction`, whose typed `ActionResult` this
 * component branches on directly — there is no untyped success path to fall
 * into, so an RLS denial can only render as an inline error, never a
 * success toast.
 */
export const OrganizationForm = ({ org }: Props) => {
  const { t } = useTranslate();
  const { enqueueSnackbar } = useSnackbar();

  const methods = useForm({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      companyName: org?.companyName ?? "",
      tenantId: org?.tenantId ?? "",
    },
  });

  const {
    handleSubmit,
    setError,
    formState: { isSubmitting },
  } = methods;

  const onSubmit = handleSubmit(async (data) => {
    try {
      const result = await updateOrganizationAction(data);
      if (!result.ok) {
        setError("companyName", { message: result.error.message });
        enqueueSnackbar(
          result.error.message || t("dashboard.settings.organization.form.errorNotification"),
          { variant: "error" },
        );
        return;
      }
      enqueueSnackbar(t("dashboard.settings.organization.form.successNotification"), {
        variant: "success",
      });
    } catch {
      enqueueSnackbar(t("dashboard.settings.organization.form.errorNotification"), {
        variant: "error",
      });
    }
  });

  return (
    <FormProvider methods={methods} onSubmit={onSubmit}>
      <SettingsSection
        description={t("dashboard.settings.organization.description")}
        footer={{
          action: (
            <Button type="submit" variant="contained" loading={isSubmitting}>
              {t("dashboard.settings.organization.form.saveButton")}
            </Button>
          ),
        }}
      >
        <Stack sx={{ gap: 4 }}>
          <RHFTextField
            disabled
            name="tenantId"
            label={t("dashboard.settings.organization.form.organizationIdPlaceholder")}
          />
          <RHFTextField
            name="companyName"
            label={t("dashboard.settings.organization.form.companyNamePlaceholder")}
          />
        </Stack>
      </SettingsSection>
    </FormProvider>
  );
};
