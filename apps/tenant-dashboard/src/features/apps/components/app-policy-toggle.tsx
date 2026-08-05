"use client";

import { useState } from "react";
import {
  CircularProgress,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { Stack } from "@mui/system";
import { useTranslate } from "@outerlayer/locales";
import { useSnackbar } from "notistack";

type Props = {
  initialValue: boolean;
  /** False for non-admin/owner: the switch renders disabled with a tooltip. */
  canEdit: boolean;
  /** Persist the new value; an `error` reverts the switch and is surfaced. */
  save: (value: boolean) => Promise<{ error?: string } | undefined | void>;
  labelKey: string;
  descriptionKey: string;
  savedKey: string;
  noPermissionKey: string;
};

/**
 * A per-app publish-policy switch (require-PR, PR previews, …). Persists via
 * `save`; optimistic, reverting the switch if the server rejects the change.
 */
export const AppPolicyToggle = ({
  initialValue,
  canEdit,
  save,
  labelKey,
  descriptionKey,
  savedKey,
  noPermissionKey,
}: Props) => {
  const { t } = useTranslate();
  const { enqueueSnackbar } = useSnackbar();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);

  const handleChange = async (
    _event: unknown,
    checked: boolean
  ): Promise<void> => {
    setValue(checked);
    setSaving(true);
    const response = await save(checked);
    setSaving(false);

    if (response?.error) {
      setValue(!checked);
      enqueueSnackbar(response.error, { variant: "error" });
      return;
    }
    enqueueSnackbar(t(savedKey), { variant: "success" });
  };

  const control = (
    <Switch
      size="small"
      checked={value}
      onChange={handleChange}
      disabled={!canEdit || saving}
    />
  );

  return (
    <Stack>
      <Stack direction="row" spacing={1} sx={{
        alignItems: "center"
      }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: "bold",
            color: "text.secondary",
            minWidth: 100
          }}>
          {t(labelKey)}
        </Typography>
        {canEdit ? (
          control
        ) : (
          <Tooltip title={t(noPermissionKey)}>
            {/* span wrapper so the tooltip fires over the disabled switch */}
            <span>{control}</span>
          </Tooltip>
        )}
        {saving && <CircularProgress size={14} />}
      </Stack>
      <Typography variant="caption" sx={{
        color: "text.secondary"
      }}>
        {t(descriptionKey)}
      </Typography>
    </Stack>
  );
};
