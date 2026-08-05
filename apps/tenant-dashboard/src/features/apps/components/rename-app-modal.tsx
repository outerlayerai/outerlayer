import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useSnackbar } from "notistack";
import { renameAppAction } from "../actions";

type Props = {
  appId: string;
  /** Current display_name (may be null/empty when the app falls back to its identifier). */
  displayName: string | null | undefined;
  /** URL identifier (slug) — shown as the placeholder so the user knows the fallback. */
  identifier: string;
  open: boolean;
  onClose: () => void;
  t: (key: string) => string;
};

/**
 * Rename only edits `display_name` — the UI-facing label. The app's
 * `name` (the URL-stable slug) is intentionally immutable here so
 * renaming never breaks existing links or bookmarks. Sending an empty
 * value clears `display_name` (null), so the app falls back to its
 * identifier everywhere it renders.
 */
export const RenameAppModal = ({
  appId,
  displayName,
  identifier,
  open,
  onClose,
  t,
}: Props) => {
  const [value, setValue] = useState(displayName ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const { enqueueSnackbar } = useSnackbar();

  // Re-seed the field whenever the dialog opens for a (possibly different) app.
  useEffect(() => {
    if (open) {
      setValue(displayName ?? "");
      setError("");
    }
  }, [open, displayName]);

  const handleClose = () => {
    setError("");
    onClose();
  };

  const handleSave = async () => {
    const trimmed = value.trim();
    if (trimmed.length > 100) {
      setError(t("validation.name.max"));
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      // Empty input clears the override (null) → app renders its identifier.
      const result = await renameAppAction({ appId, displayName: trimmed || null });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        enqueueSnackbar(result.data.message, { variant: "error" });
        return;
      }
      enqueueSnackbar(t("renameSuccess"), { variant: "success" });
      handleClose();
    } catch {
      enqueueSnackbar(t("renameFailed"), { variant: "error" });
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog fullWidth open={open} onClose={handleClose}>
      <DialogTitle>{t("renameAppTitle")}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          margin="dense"
          fullWidth
          label={t("displayName")}
          placeholder={identifier}
          value={value}
          error={!!error}
          helperText={error || t("displayNameHelper")}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError("");
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>{t("cancel")}</Button>
        <Button variant="contained" loading={saving} onClick={handleSave}>
          {t("renameButton")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
