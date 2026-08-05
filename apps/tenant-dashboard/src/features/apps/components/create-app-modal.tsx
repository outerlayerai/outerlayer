"use client";

import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField, Button } from "@mui/material";
import { useBoolean } from "@/hooks/use-boolean";
import { useEffect, useState } from "react";
import {
  uniqueNamesGenerator,
  Config,
  colors,
  animals,
  names,
  languages,
} from "unique-names-generator";
import { useSnackbar } from "notistack";
import { useTranslate } from "@outerlayer/locales";
import { fUniqueNameGenerator } from "@/utils/format-unique-name-generator";
import { createAppAction } from "../actions";
import { UpgradePrompt } from "@/components/upgrade-prompt";
import {
  ENTITLEMENTS,
  type EntitlementDeniedInfo,
  type EntitlementKey,
} from "@/config/entitlements";
import { buildDeniedInfo } from "@/lib/adapters/build-denied-info";
import type { AppActionFailure } from "../types";

const customConfig: Config = {
  dictionaries: [names, languages, colors, animals],
  separator: "-",
  length: 3,
};

const getTranslationKey = (key: string) => `app.${key}`;

/**
 * Reconstruct an `EntitlementDeniedInfo` from the action's entitlement
 * failure shape (mirrors the gateway's 402 envelope: `entitlement`, `limit`,
 * `current`). Hands off to `buildDeniedInfo`, which looks up the rich tier
 * info from the static config so the upgrade prompt has every field it needs.
 */
function entitlementDeniedFromError(
  failure: AppActionFailure,
): EntitlementDeniedInfo | null {
  if (failure.errorCode !== "entitlement_required") return null;
  const key = failure.entitlement;
  if (typeof key !== "string" || !(key in ENTITLEMENTS)) return null;
  return buildDeniedInfo(key as EntitlementKey, {
    allowed: false,
    limit: failure.limit ?? 0,
    currentCount: failure.current ?? 0,
  });
}

export const CreateAppModal = () => {
  const dialog = useBoolean();

  const [name, setName] = useState(
    fUniqueNameGenerator(uniqueNamesGenerator(customConfig))
  );
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [deniedInfo, setDeniedInfo] = useState<EntitlementDeniedInfo | null>(null);
  const [saving, setSaving] = useState(false);

  const { t: translate } = useTranslate();

  const t = (key: string) => translate(getTranslationKey(key));

  const { enqueueSnackbar } = useSnackbar();

  useEffect(() => {
    if (dialog.value) {
      setName(fUniqueNameGenerator(uniqueNamesGenerator(customConfig)));
      setDisplayName("");
    } else {
      setError("");
      setName("");
      setDisplayName("");
      setDeniedInfo(null);
    }
  }, [dialog.value]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("validation.name.required"));
      return;
    }
    if (trimmedName.length > 100) {
      setError(t("validation.name.max"));
      return;
    }

    const trimmedDisplayName = displayName.trim();
    if (trimmedDisplayName.length > 100) {
      setError(t("validation.name.max"));
      return;
    }

    setSaving(true);
    try {
      const result = await createAppAction({
        name: trimmedName,
        displayName: trimmedDisplayName || undefined,
      });

      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        const failure = result.data;
        const denied = entitlementDeniedFromError(failure);
        if (denied) {
          setDeniedInfo(denied);
          return;
        }
        if (failure.errorCode === "duplicate_app_name") {
          // Surface as inline name error rather than a snackbar — the
          // duplicate name is a form-field problem, not a background failure.
          setError(failure.message);
          return;
        }
        enqueueSnackbar(failure.message, { variant: "error" });
        return;
      }

      setDeniedInfo(null);
      dialog.onFalse();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="contained"
        onClick={dialog.onTrue}
      >
        {t("createButton")}
      </Button>
      <Dialog open={dialog.value} fullWidth onClose={dialog.onFalse}>
        <DialogTitle>{t("createAppTitle")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            fullWidth
            label={t("displayName")}
            placeholder={name}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              if (error) setError("");
            }}
            error={!!error}
            helperText={error || t("displayNameHelper")}
          />
          <TextField
            margin="dense"
            fullWidth
            label={t("identifier")}
            value={name}
            helperText={t("identifierHelper")}
            disabled
          />
          {deniedInfo && (
            <UpgradePrompt info={deniedInfo} variant="inline" />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={handleSave}
            variant="contained"
            loading={saving}
          >
            {t("saveButton")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
