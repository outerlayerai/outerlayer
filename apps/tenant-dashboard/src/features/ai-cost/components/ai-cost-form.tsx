"use client";

import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslate } from "@outerlayer/locales";
import { useSnackbar } from "notistack";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { Stack } from "@mui/system";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { SettingsSection } from "@/components/settings-shell";
import { fCurrency } from "@/utils/format-number";

import { updateAiCostConfigAction } from "../actions";
import type { AiCostConfig } from "../types";

type Props = {
  /** Config seeded by a React Server Component (RSC); null when never
   *  configured or the read was denied — both render as zeros. */
  initial: AiCostConfig | null;
};

/**
 * Org-wide AI program costs: paid tool seats × blended $/seat/month. Feeds
 * the "Total Cost of AI" dashboard tile (seat spend prorated to the widget
 * window + metered token spend). RSC-seeded, no client-side fetch — the
 * write goes through `updateAiCostConfigAction`, whose typed `ActionResult`
 * this component branches on directly.
 */
export const AiCostForm = ({ initial }: Props) => {
  const { t } = useTranslate();
  const { enqueueSnackbar } = useSnackbar();

  const FormSchema = z.object({
    seatCount: z.coerce
      .number({ message: t("dashboard.settings.aiCost.form.numberInvalid") })
      .int(t("dashboard.settings.aiCost.form.numberInvalid"))
      .min(0, t("dashboard.settings.aiCost.form.numberNegative")),
    costPerSeatUsd: z.coerce
      .number({ message: t("dashboard.settings.aiCost.form.numberInvalid") })
      .min(0, t("dashboard.settings.aiCost.form.numberNegative")),
  });

  const methods = useForm({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      seatCount: initial?.seatCount ?? 0,
      costPerSeatUsd: initial?.costPerSeatUsd ?? 0,
    },
  });

  const {
    handleSubmit,
    setError,
    watch,
    formState: { isSubmitting },
  } = methods;

  const seatCount = Number(watch("seatCount")) || 0;
  const costPerSeat = Number(watch("costPerSeatUsd")) || 0;
  const monthlyTotal = seatCount * costPerSeat;

  const onSubmit = handleSubmit(async (data) => {
    try {
      const result = await updateAiCostConfigAction(data);
      if (!result.ok) {
        setError("seatCount", { message: result.error.message });
        enqueueSnackbar(
          result.error.message || t("dashboard.settings.aiCost.form.errorNotification"),
          { variant: "error" },
        );
        return;
      }
      enqueueSnackbar(t("dashboard.settings.aiCost.form.successNotification"), {
        variant: "success",
      });
    } catch {
      enqueueSnackbar(t("dashboard.settings.aiCost.form.errorNotification"), {
        variant: "error",
      });
    }
  });

  return (
    <FormProvider methods={methods} onSubmit={onSubmit}>
      <SettingsSection
        description={t("dashboard.settings.aiCost.description")}
        footer={{
          action: (
            <Button type="submit" variant="contained" loading={isSubmitting}>
              {t("dashboard.settings.aiCost.form.saveButton")}
            </Button>
          ),
        }}
      >
        <Stack sx={{ gap: 4 }}>
          <RHFTextField
            name="seatCount"
            type="number"
            label={t("dashboard.settings.aiCost.form.seatCountLabel")}
            helperText={t("dashboard.settings.aiCost.form.seatCountHelp")}
          />
          <RHFTextField
            name="costPerSeatUsd"
            type="number"
            label={t("dashboard.settings.aiCost.form.costPerSeatLabel")}
            helperText={t("dashboard.settings.aiCost.form.costPerSeatHelp")}
          />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("dashboard.settings.aiCost.form.monthlyTotalPrefix")}{" "}
            <strong>{fCurrency(monthlyTotal, 2)}</strong>
          </Typography>
        </Stack>
      </SettingsSection>
    </FormProvider>
  );
};
