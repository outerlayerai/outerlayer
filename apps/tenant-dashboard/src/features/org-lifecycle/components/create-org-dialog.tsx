"use client";

import { useCallback, useEffect } from "react";

import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { useCreateOrg } from "../hooks";

// ----------------------------------------------------------------------

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Create-organization dialog, opened from the org switcher and the /orgs
 * picker. Company Name is the only field — the URL slug is generated silently
 * (see useCreateOrg). Shares its submit logic with the empty-state card.
 */
export default function CreateOrgDialog({ open, onClose }: Props) {
  const { methods, onSubmit, isSubmitting, isAtOrgLimit, t } = useCreateOrg({
    onDone: onClose,
  });

  const { reset } = methods;

  // Reset the field each time the dialog opens.
  useEffect(() => {
    if (open) reset({ companyName: "" });
  }, [open, reset]);

  const handleClose = useCallback(() => {
    reset({ companyName: "" });
    onClose();
  }, [onClose, reset]);

  return (
    <Dialog open={open} fullWidth onClose={handleClose}>
      <DialogTitle>{t("createOrgTitle")}</DialogTitle>

      <FormProvider methods={methods} onSubmit={onSubmit}>
        <DialogContent>
          <RHFTextField
            name="companyName"
            label={t("companyName")}
            placeholder={t("companyNamePlaceholder")}
            margin="dense"
            disabled={isAtOrgLimit}
            autoFocus
          />
        </DialogContent>

        <DialogActions>
          <Button
            type="submit"
            variant="contained"
            loading={isSubmitting}
            disabled={isAtOrgLimit}
          >
            {t("saveButton")}
          </Button>
        </DialogActions>
      </FormProvider>
    </Dialog>
  );
}
