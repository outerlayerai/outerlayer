"use client";

import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  InputAdornment,
  IconButton,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { useState, useEffect } from "react";
import { useTranslate } from "@outerlayer/locales";
import { isReservedEnvVar, RESERVED_ENV_VAR_MESSAGE } from "@/lib/environments/reserved-env-vars";
import {
  type EnvVarTargetChoice,
  KIND_CHOICES,
  KIND_TARGET_LABELS,
} from "./env-var-targets";

interface EnvVarFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (
    key: string,
    value: string,
    targets: EnvVarTargetChoice[],
  ) => Promise<void>;
  initialKey?: string;
  isEditing?: boolean;
  /** Whether to show the target multi-select (add mode only). */
  showTargets?: boolean;
  /** Current environment name — labels the "this environment" target chip. */
  currentEnvName?: string;
}

// ============================================================================
// Validation
// ============================================================================

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function validateKey(key: string, t: (key: string) => string): string {
  if (!key) return t("dashboard.apps.envVars.validation.keyRequired");
  if (!ENV_KEY_PATTERN.test(key)) {
    return t("dashboard.apps.envVars.validation.keyPattern");
  }
  if (isReservedEnvVar(key)) {
    return RESERVED_ENV_VAR_MESSAGE;
  }
  return "";
}

// ============================================================================
// Component
// ============================================================================

export function EnvVarFormDialog({
  open,
  onClose,
  onSave,
  initialKey,
  isEditing,
  showTargets,
  currentEnvName,
}: EnvVarFormDialogProps) {
  const { t } = useTranslate();
  const [key, setKey] = useState(initialKey ?? "");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState("");
  // Default to "all" — the common case is a var that applies everywhere; the
  // user narrows it to preview/production as needed.
  const [targets, setTargets] = useState<Set<EnvVarTargetChoice>>(
    new Set(["all"]),
  );

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      setKey(initialKey ?? "");
      setValue("");
      setShowValue(false);
      setKeyError("");
      setTargets(new Set(["all"]));
    }
  }, [open, initialKey]);

  const handleKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const upper = e.target.value.toUpperCase();
    setKey(upper);
    if (keyError) {
      setKeyError(validateKey(upper, t));
    }
  };

  // 'all' is exclusive of every other target. 'env' (a specific-env override)
  // can coexist with the individual kinds but NOT with 'all' — "only this env"
  // contradicts "all environments", and since 'all' is the default selection,
  // leaving it set would silently also write an all-kinds row (leaking the var
  // to every environment, including production).
  const toggleTarget = (choice: EnvVarTargetChoice) => {
    setTargets((prev) => {
      const next = new Set(prev);
      const has = next.has(choice);
      if (choice === "all") {
        next.clear();
        if (!has) next.add("all");
      } else if (choice === "env") {
        if (has) {
          next.delete("env");
        } else {
          next.delete("all");
          next.add("env");
        }
      } else {
        next.delete("all");
        if (has) next.delete(choice);
        else next.add(choice);
      }
      return next;
    });
  };

  const targetsValid = !showTargets || targets.size > 0;

  const handleSave = async () => {
    const error = validateKey(key, t);
    if (error) {
      setKeyError(error);
      return;
    }
    if (!value || !targetsValid) return;

    setSaving(true);
    try {
      await onSave(key, value, [...targets]);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {isEditing ? t("dashboard.apps.envVars.updateDialogTitle") : t("dashboard.apps.envVars.addDialogTitle")}
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus={!isEditing}
          margin="dense"
          label={t("dashboard.apps.envVars.keyLabel")}
          fullWidth
          value={key}
          onChange={handleKeyChange}
          onBlur={() => setKeyError(validateKey(key, t))}
          error={!!keyError}
          helperText={keyError || t("dashboard.apps.envVars.keyHelper")}
          disabled={isEditing}
          placeholder={t("dashboard.apps.envVars.keyPlaceholder")}
          sx={{ mt: 1 }}
        />
        <TextField
          margin="dense"
          label={t("dashboard.apps.envVars.valueLabel")}
          fullWidth
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type={showValue ? "text" : "password"}
          placeholder={isEditing ? t("dashboard.apps.envVars.valuePlaceholderEdit") : t("dashboard.apps.envVars.valuePlaceholder")}
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowValue((prev) => !prev)}
                    edge="end"
                    size="small"
                  >
                    <Iconify
                      icon={showValue ? "eva:eye-off-fill" : "eva:eye-fill"}
                    />
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
        {showTargets && (
          <>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                mt: 2,
                display: "block"
              }}>
              Applies to
            </Typography>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{
                flexWrap: "wrap",
                mt: 1
              }}>
              {KIND_CHOICES.map((choice) => (
                <Chip
                  key={choice}
                  label={KIND_TARGET_LABELS[choice]}
                  onClick={() => toggleTarget(choice)}
                  color={targets.has(choice) ? "primary" : "default"}
                  variant={targets.has(choice) ? "filled" : "outlined"}
                  size="small"
                />
              ))}
              {currentEnvName && (
                <Chip
                  label={`Only ${currentEnvName}`}
                  onClick={() => toggleTarget("env")}
                  color={targets.has("env") ? "secondary" : "default"}
                  variant={targets.has("env") ? "filled" : "outlined"}
                  size="small"
                />
              )}
            </Stack>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          {t("dashboard.apps.envVars.cancelButton")}
        </Button>
        <Button
          onClick={handleSave}
          loading={saving}
          variant="contained"
          disabled={!key || !value || !targetsValid || !!validateKey(key, t)}
        >
          {isEditing ? t("dashboard.apps.envVars.updateButton") : t("dashboard.apps.envVars.addButton")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
